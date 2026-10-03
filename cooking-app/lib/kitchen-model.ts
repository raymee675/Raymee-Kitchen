// The rendered griddle is 16:9. Keep the oval's physical shape unchanged by
// expressing its horizontal radius as a fraction of the wider board.
export const OVAL_RX = 0.07875;
export const OVAL_RY = 0.095;
export const TIMER_DURATION = 90;
export const COMPLETION_BOX_DURATION = 30 * 60;
export const DEFAULT_TEMPERATURE = 96;
export const LEGACY_SERVICE_OUTCOME = "導入前・判定不可";
export const PLATE_DISCARD_REASON = "盤外破棄";
export const COMPLETION_EXPIRED_REASON = "30分経過";

export interface Pancake {
  id: string;
  plate: 1 | 2;
  x: number;
  y: number;
  // Kept in the stored/API shape for older clients, but canonicalized to 90.
  duration: number;
  temperature: number;
  startedAt: number | null;
  // Open intervals have endedAt === null. A null temperature means that the
  // interval predates temperature tracking and must remain explicitly unknown.
  segments: HeatingSegment[];
  version: number;
}
export interface HeatingSegment { temperature: number | null; startedAt: number; endedAt: number | null }
export interface ExecutionRecordSegment { temperature: number | null; startedAt: number; endedAt: number }
export interface ExecutionRecord {
  id: string;
  startedAt: number;
  collectedAt: number;
  segments: ExecutionRecordSegment[];
  cookCompletedAt: number | null;
  serveTimerStartedAt: number | null;
  serveDeadlineAt: number | null;
  servedAt: number | null;
  unavailableAt: number | null;
  unavailableReason: string | null;
}
export interface CompletionItem { id: string; version: number }
export type StoredPancake = Omit<Pancake, "temperature" | "segments"> & { temperature?: number; segments?: HeatingSegment[] };
export interface Snapshot { revision: number; items: Pancake[]; records: ExecutionRecord[]; completionItems: CompletionItem[]; serverNow: number; serverReceivedAt?: number }
export function clockSample(serverNow:number, serverReceivedAt:number, elapsed:number) {
  const networkRtt = Math.max(0, elapsed - Math.max(0, serverNow - serverReceivedAt));
  return {networkRtt, estimatedNow:serverNow + networkRtt / 2};
}
export type Command =
  | { operationId: string; type: "create"; id: string; plate: 1 | 2; x: number; y: number }
  | { operationId: string; type: "start" | "remove" | "delete"; id: string; expectedVersion: number }
  | { operationId: string; type: "move"; id: string; expectedVersion: number; plate: 1 | 2; x: number; y: number }
  | { operationId: string; type: "adjust"; id: string; expectedVersion: number; delta: -1 | 1 };

export function normalizePancake(item: StoredPancake): Pancake {
  let segments: HeatingSegment[];
  if (item.segments === undefined) {
    // Legacy active items did not retain temperature changes. Mark the entire
    // known portion as unknown instead of inferring from the current setting.
    segments = item.startedAt === null ? [] : [{temperature:null, startedAt:item.startedAt, endedAt:null}];
  } else {
    if (!Array.isArray(item.segments)) throw new Error("保存データの温度区間が正しくありません。");
    segments = item.segments.map(segment => {
      if (!segment || !Number.isFinite(segment.startedAt) || segment.startedAt < 0
        || !(segment.temperature === null || Number.isSafeInteger(segment.temperature))
        || !(segment.endedAt === null || (Number.isFinite(segment.endedAt) && segment.endedAt >= segment.startedAt))) {
        throw new Error("保存データの温度区間が正しくありません。");
      }
      return {temperature:segment.temperature, startedAt:segment.startedAt, endedAt:segment.endedAt};
    });
  }
  if (item.startedAt === null) {
    if (segments.length) throw new Error("待機中のお好み焼きに温度区間があります。");
  } else {
    if (!segments.length || segments[0].startedAt !== item.startedAt || segments[segments.length - 1].endedAt !== null
      || segments.slice(0, -1).some(segment => segment.endedAt === null)
      || segments.some((segment, index) => index > 0 && segments[index - 1].endedAt !== segment.startedAt)) {
      throw new Error("保存データの温度区間が連続していません。");
    }
  }
  return {
    ...item,
    duration: TIMER_DURATION,
    temperature: item.temperature !== undefined && Number.isSafeInteger(item.temperature)
      ? item.temperature
      : DEFAULT_TEMPERATURE,
    segments,
  };
}

export function normalizePancakes(items: readonly StoredPancake[]): Pancake[] {
  return items.map(normalizePancake);
}

export function normalizeExecutionRecords(value: unknown): ExecutionRecord[] {
  if (!Array.isArray(value)) throw new Error("保存データの実行記録が正しくありません。");
  const ids = new Set<string>();
  return value.map(record => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("保存データの実行記録が正しくありません。");
    const candidate = record as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !Number.isFinite(candidate.startedAt) || !Number.isFinite(candidate.collectedAt)
      || (candidate.collectedAt as number) < (candidate.startedAt as number) || !Array.isArray(candidate.segments) || candidate.segments.length === 0) {
      throw new Error("保存データの実行記録が正しくありません。");
    }
    const segments: ExecutionRecordSegment[] = candidate.segments.map((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("保存データの実行区間が正しくありません。");
      const segment = raw as Record<string, unknown>;
      if (!(segment.temperature === null || Number.isSafeInteger(segment.temperature))
        || !Number.isFinite(segment.startedAt) || !Number.isFinite(segment.endedAt)
        || (segment.endedAt as number) < (segment.startedAt as number)) throw new Error("保存データの実行区間が正しくありません。");
      return {temperature:segment.temperature as number | null, startedAt:segment.startedAt as number, endedAt:segment.endedAt as number};
    });
    if (segments[0].startedAt !== candidate.startedAt || segments[segments.length - 1].endedAt !== candidate.collectedAt
      || segments.some((segment, index) => index > 0 && segments[index - 1].endedAt !== segment.startedAt)) {
      throw new Error("保存データの実行区間が連続していません。");
    }
    if (ids.has(candidate.id)) throw new Error("保存データに重複した実行記録IDがあります。");
    ids.add(candidate.id);
    const serviceKeys = ["cookCompletedAt", "serveTimerStartedAt", "serveDeadlineAt", "servedAt", "unavailableAt", "unavailableReason"];
    const hasServiceData = serviceKeys.some(key => Object.prototype.hasOwnProperty.call(candidate, key));
    if (!hasServiceData) {
      return {
        id:candidate.id,
        startedAt:candidate.startedAt as number,
        collectedAt:candidate.collectedAt as number,
        segments,
        cookCompletedAt:null,
        serveTimerStartedAt:null,
        serveDeadlineAt:null,
        servedAt:null,
        unavailableAt:null,
        unavailableReason:LEGACY_SERVICE_OUTCOME,
      };
    }
    const nullableTime = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (serviceKeys.some(key => !Object.prototype.hasOwnProperty.call(candidate, key))
      || !nullableTime(candidate.cookCompletedAt)
      || !nullableTime(candidate.serveTimerStartedAt)
      || !nullableTime(candidate.serveDeadlineAt)
      || !nullableTime(candidate.servedAt)
      || !nullableTime(candidate.unavailableAt)
      || !(candidate.unavailableReason === null || typeof candidate.unavailableReason === "string")) {
      throw new Error("保存データの提供記録が正しくありません。");
    }
    const service = {
      cookCompletedAt:candidate.cookCompletedAt as number | null,
      serveTimerStartedAt:candidate.serveTimerStartedAt as number | null,
      serveDeadlineAt:candidate.serveDeadlineAt as number | null,
      servedAt:candidate.servedAt as number | null,
      unavailableAt:candidate.unavailableAt as number | null,
      unavailableReason:candidate.unavailableReason as string | null,
    };
    // Legacy records are normalized with explicit unknown fields, so they
    // must remain readable on every later load as well as on first migration.
    if (service.unavailableReason === LEGACY_SERVICE_OUTCOME) {
      if (service.cookCompletedAt !== null || service.serveTimerStartedAt !== null
        || service.serveDeadlineAt !== null || service.servedAt !== null || service.unavailableAt !== null) {
        throw new Error("保存データの旧提供記録が正しくありません。");
      }
      return {id:candidate.id, startedAt:candidate.startedAt as number, collectedAt:candidate.collectedAt as number, segments, ...service};
    }
    if (service.cookCompletedAt !== (candidate.startedAt as number) + TIMER_DURATION * 1000) {
      throw new Error("保存データの焼き上がり時刻が正しくありません。");
    }
    if (service.serveTimerStartedAt === null) {
      if (service.cookCompletedAt === null || service.serveDeadlineAt !== null || service.servedAt !== null
        || service.unavailableAt === null || service.unavailableReason !== PLATE_DISCARD_REASON) {
        throw new Error("保存データの完成ボックス状態が正しくありません。");
      }
    } else {
      if (service.cookCompletedAt === null || service.serveTimerStartedAt !== (candidate.collectedAt as number)
        || service.serveDeadlineAt !== service.serveTimerStartedAt + COMPLETION_BOX_DURATION * 1000
        || service.serveTimerStartedAt < service.cookCompletedAt) {
        throw new Error("保存データの完成ボックス期限が正しくありません。");
      }
      if (service.servedAt !== null) {
        if (service.servedAt < service.serveTimerStartedAt || service.servedAt >= service.serveDeadlineAt
          || service.unavailableAt !== null || service.unavailableReason !== null) {
          throw new Error("保存データの提供時刻が正しくありません。");
        }
      } else if (service.unavailableAt !== null) {
        if (service.unavailableAt !== service.serveDeadlineAt || service.unavailableReason !== COMPLETION_EXPIRED_REASON) {
          throw new Error("保存データの提供不可時刻が正しくありません。");
        }
      } else if (service.unavailableReason !== null) {
        throw new Error("保存データの提供不可理由が正しくありません。");
      }
    }
    return {id:candidate.id, startedAt:candidate.startedAt as number, collectedAt:candidate.collectedAt as number, segments, ...service};
  });
}

export function normalizeCompletionItems(value: unknown, records: readonly ExecutionRecord[]): CompletionItem[] {
  if (!Array.isArray(value)) throw new Error("保存データの完成ボックスが正しくありません。");
  const ids = new Set<string>();
  const recordById = new Map(records.map(record => [record.id, record]));
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("保存データの完成ボックスが正しくありません。");
    const candidate = item as Record<string, unknown>;
    const record = typeof candidate.id === "string" ? recordById.get(candidate.id) : undefined;
    if (typeof candidate.id !== "string" || !Number.isSafeInteger(candidate.version) || (candidate.version as number) < 1
      || ids.has(candidate.id) || !record || record.serveTimerStartedAt === null
      || record.servedAt !== null || record.unavailableAt !== null || record.unavailableReason !== null) {
      throw new Error("保存データの完成ボックス項目が正しくありません。");
    }
    ids.add(candidate.id);
    return {id:candidate.id, version:candidate.version as number};
  });
}

export function completionStatus(record: ExecutionRecord, now: number): "holding" | "served" | "unavailable" | "legacy" {
  if (record.unavailableReason === LEGACY_SERVICE_OUTCOME) return "legacy";
  if (record.servedAt !== null) return "served";
  if (record.unavailableAt !== null || record.serveTimerStartedAt === null
    || (record.serveDeadlineAt !== null && now >= record.serveDeadlineAt)) return "unavailable";
  return "holding";
}

export function completionTimer(record: ExecutionRecord, now: number) {
  const state = completionStatus(record, now) === "holding" ? "holding" as const : "unavailable" as const;
  const remainingMs = state === "holding" && record.serveDeadlineAt !== null
    ? Math.max(0, record.serveDeadlineAt - now)
    : 0;
  return {state, remainingMs, remainingSeconds:Math.ceil(remainingMs / 1000)};
}

export class KitchenError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.code=code; this.status=status; }
}
export function timer(item: Pancake, now: number) {
  if (item.startedAt === null) return { state: "blank" as const, remaining: TIMER_DURATION, progress: 0 };
  const remainingMs = Math.max(0, item.startedAt + TIMER_DURATION * 1000 - now);
  return { state: remainingMs === 0 ? "done" as const : "running" as const,
    remaining: Math.ceil(remainingMs / 1000),
    progress: Math.min(1, Math.max(0, (now - item.startedAt) / (TIMER_DURATION * 1000))) };
}
export function clampPosition(x: number, y: number) {
  return { x: Math.max(OVAL_RX + 0.02, Math.min(1 - OVAL_RX - 0.02, x)),
    y: Math.max(OVAL_RY + 0.02, Math.min(1 - OVAL_RY - 0.02, y)) };
}
export function overlaps(a: {x: number; y: number}, b: {x: number; y: number}) {
  return ((a.x - b.x) / (2 * OVAL_RX + 0.025)) ** 2 + ((a.y - b.y) / (2 * OVAL_RY + 0.025)) ** 2 < 1;
}
export function gesture(dx: number, dy: number, maximumDistance: number) {
  if (maximumDistance < 10) return "tap";
  if (Math.abs(dx) >= 30 && Math.abs(dx) > Math.abs(dy) * 1.4) return dx > 0 ? "right" : "left";
  if (dy <= -30 && -dy > Math.abs(dx) * 1.4) return "up";
  return "none";
}
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function parseCommand(input: unknown): Command {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KitchenError("invalid", "操作内容を確認してください。", 400);
  const c = input as Record<string, unknown>;
  if (!isId(c.operationId) || !isId(c.id)) throw new KitchenError("invalid", "操作IDが正しくありません。", 400);
  if (c.type === "create" && (c.plate === 1 || c.plate === 2) && typeof c.x === "number" && typeof c.y === "number" && Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1) {
    return { operationId:c.operationId, type:c.type, id:c.id, plate:c.plate, x:c.x, y:c.y };
  }
  if ((c.type === "start" || c.type === "remove" || c.type === "delete" || c.type === "adjust" || c.type === "move") && Number.isSafeInteger(c.expectedVersion) && (c.expectedVersion as number) > 0) {
    const base = { operationId:c.operationId, id:c.id, expectedVersion:c.expectedVersion as number };
    if (c.type === "start" || c.type === "remove" || c.type === "delete") return {...base, type:c.type};
    if (c.type === "adjust" && (c.delta === -1 || c.delta === 1)) return {...base, type:c.type, delta:c.delta};
    if (c.type === "move" && (c.plate === 1 || c.plate === 2) && typeof c.x === "number" && typeof c.y === "number" && Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1) {
      return {...base, type:c.type, plate:c.plate, x:c.x, y:c.y};
    }
  }
  throw new KitchenError("invalid", "操作内容が正しくありません。", 400);
}
export function applySnapshotCommand(snapshot: Snapshot, command: Command, now: number): Snapshot {
  const canonicalItems = normalizePancakes(snapshot.items);
  const records = normalizeExecutionRecords(snapshot.records ?? []);
  const completionItems = normalizeCompletionItems(snapshot.completionItems ?? [], records);
  if (command.type === "create") {
    if (canonicalItems.some(i => i.id === command.id) || records.some(record => record.id === command.id)) {
      throw new KitchenError("exists", "このお好み焼きIDはすでに使用されています。");
    }
    const position = clampPosition(command.x, command.y);
    if (canonicalItems.some(i => i.plate === command.plate && overlaps(i, position))) throw new KitchenError("overlap", "少し離れた空き場所をタップしてください。");
    return {...snapshot, items:[...canonicalItems, {id:command.id, plate:command.plate, ...position, duration:TIMER_DURATION, temperature:DEFAULT_TEMPERATURE, startedAt:null, segments:[], version:1}], records, completionItems};
  }
  if (command.type === "remove") {
    const completionItem = completionItems.find(item => item.id === command.id);
    if (completionItem) {
      if (completionItem.version !== command.expectedVersion) throw new KitchenError("conflict", "完成ボックスの状態が更新されています。最新の表示でもう一度操作してください。");
      const record = records.find(item => item.id === completionItem.id);
      if (!record || record.serveDeadlineAt === null || record.serveTimerStartedAt === null) {
        throw new KitchenError("invalid_state", "完成ボックスの期限を確認できません。");
      }
      const deadline = record.serveDeadlineAt;
      const serveAt = Math.max(now, record.serveTimerStartedAt);
      const updated = serveAt < deadline
        ? {...record, servedAt:serveAt}
        : {...record, unavailableAt:deadline, unavailableReason:COMPLETION_EXPIRED_REASON};
      return {
        ...snapshot,
        items:canonicalItems,
        records:records.map(item => item.id === updated.id ? updated : item),
        completionItems:completionItems.filter(item => item.id !== completionItem.id),
      };
    }
  }
  const item = canonicalItems.find(i => i.id === command.id);
  if (!item) throw new KitchenError("removed", "このお好み焼きは取り出されています。");
  if (command.type === "start" && item.startedAt !== null) return {...snapshot, items:canonicalItems, records, completionItems};
  if (item.version !== command.expectedVersion) throw new KitchenError("conflict", "別の端末で変更されました。最新の表示でもう一度操作してください。");
  const current = timer(item, now);
  if (command.type === "delete" || command.type === "remove") {
    if (command.type === "remove" && current.state !== "done") throw new KitchenError("not_finished", "焼き上がった赤いお好み焼きをタップしてください。");
    const completed = current.state === "done" ? collectRecord(item, now, command.type === "remove" ? "box" : "discard") : null;
    return {
      ...snapshot,
      items:canonicalItems.filter(i => i.id !== item.id),
      records:completed ? [...records, completed] : records,
      completionItems:completed?.serveTimerStartedAt !== null && completed ? [...completionItems, {id:item.id, version:1}] : completionItems,
    };
  }
  let next: Pancake;
  if (command.type === "start") next = {...item, startedAt:now, segments:[{temperature:item.temperature, startedAt:now, endedAt:null}], version:item.version + 1};
  else if (command.type === "move") {
    const position = clampPosition(command.x, command.y);
    if (canonicalItems.some(i => i.id !== item.id && i.plate === command.plate && overlaps(i, position))) {
      throw new KitchenError("overlap", "他の楕円と重なる位置には移動できません。");
    }
    next = {...item, plate:command.plate, ...position, version:item.version + 1};
  }
  else if (command.type === "adjust") {
    if (current.state === "done") throw new KitchenError("not_running", "待機中または計測中のお好み焼きだけ温度を変更できます。");
    const temperature = item.temperature + command.delta;
    if (!Number.isSafeInteger(temperature)) throw new KitchenError("temperature_limit", "これ以上温度を変更できません。");
    const segments = item.startedAt === null
      ? item.segments
      : rotateOpenSegment(item.segments, temperature, now);
    next = {...item, temperature, segments, version:item.version + 1};
  } else throw new KitchenError("invalid", "操作内容が正しくありません。", 400);
  return {...snapshot, items:canonicalItems.map(i => i.id === item.id ? next : i), records, completionItems};
}

function rotateOpenSegment(segments: HeatingSegment[], temperature: number, now: number): HeatingSegment[] {
  const current = segments[segments.length - 1];
  if (!current || current.endedAt !== null) throw new KitchenError("invalid_state", "計測中の温度区間を確認できません。");
  const boundary = Math.max(now, current.startedAt);
  return [
    ...segments.slice(0, -1),
    {...current, endedAt:boundary},
    {temperature, startedAt:boundary, endedAt:null},
  ];
}

function collectRecord(item: Pancake, now: number, disposition: "box" | "discard"): ExecutionRecord {
  if (item.startedAt === null) throw new KitchenError("invalid_state", "開始時刻がないため実行記録を作成できません。");
  const open = item.segments[item.segments.length - 1];
  if (!open || open.endedAt !== null) throw new KitchenError("invalid_state", "回収時の温度区間を確認できません。");
  const collectedAt = Math.max(now, open.startedAt);
  const segments: ExecutionRecordSegment[] = [
    ...item.segments.slice(0, -1).map(segment => ({temperature:segment.temperature, startedAt:segment.startedAt, endedAt:segment.endedAt as number})),
    {temperature:open.temperature, startedAt:open.startedAt, endedAt:collectedAt},
  ];
  const cookCompletedAt = item.startedAt + TIMER_DURATION * 1000;
  return {
    id:item.id,
    startedAt:item.startedAt,
    collectedAt,
    segments,
    cookCompletedAt,
    serveTimerStartedAt:disposition === "box" ? collectedAt : null,
    serveDeadlineAt:disposition === "box" ? collectedAt + COMPLETION_BOX_DURATION * 1000 : null,
    servedAt:null,
    unavailableAt:disposition === "discard" ? collectedAt : null,
    unavailableReason:disposition === "discard" ? PLATE_DISCARD_REASON : null,
  };
}

// Kept as an items-only adapter for existing model consumers. The storage
// paths use applySnapshotCommand so completed records commit atomically.
export function applyCommand(items: Pancake[], command: Command, now: number): Pancake[] {
  return applySnapshotCommand({revision:0, items, records:[], completionItems:[], serverNow:now}, command, now).items;
}
