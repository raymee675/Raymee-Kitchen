// Legacy free-placement bounds are retained for reading pre-grid saves.
export const LEGACY_OVAL_RX = 0.07875;
export const LEGACY_OVAL_RY = 0.095;
// Each oval is 1.15× its former size and centered in a 3×2 griddle cell.
export const OVAL_RX = LEGACY_OVAL_RX * 1.15;
export const OVAL_RY = LEGACY_OVAL_RY * 1.15;
export const GRID_COLUMNS = 3;
export const GRID_ROWS = 2;
export const GRID_CELLS_PER_PLATE = GRID_COLUMNS * GRID_ROWS;
export type GridCell = { index:number; column:number; row:number; x:number; y:number };
export const GRID_CELLS: readonly GridCell[] = Array.from({length:GRID_CELLS_PER_PLATE}, (_, index) => {
  const column = index % GRID_COLUMNS;
  const row = Math.floor(index / GRID_COLUMNS);
  return {index, column, row, x:(column + 0.5) / GRID_COLUMNS, y:(row + 0.5) / GRID_ROWS};
});
export const TIMER_DURATION = 90;
export const COMPLETION_BOX_DURATION = 30 * 60;
export const DOUGH_BATCH_SIZE = 24;
export const DOUGH_BATCH_DURATION = 20 * 60 * 1000;
export const DEFAULT_TEMPERATURE = 96;
export const LEGACY_SERVICE_OUTCOME = "導入前・判定不可";
export const PLATE_DISCARD_REASON = "盤外破棄";
export const COMPLETION_EXPIRED_REASON = "30分経過";

export interface Pancake {
  id: string;
  entityKey: string;
  creationOrdinal: number;
  plate: 1 | 2;
  x: number;
  y: number;
  griddlePlacedAt: number | null;
  movedToUpperAt: number | null;
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
  entityKey: string;
  creationOrdinal: number;
  griddlePlacedAt: number | null;
  movedToUpperAt: number | null;
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
export interface CompletionItem { id: string; entityKey: string; creationOrdinal: number; version: number }
export interface DoughBatchState {
  batchId: string;
  firstPancakeOrdinal: number;
  startedAt: number;
  deadlineAt: number;
  placedEntityKeys: string[];
  completedAt: number | null;
}
export type StoredPancake = Omit<Pancake, "temperature" | "segments" | "entityKey" | "creationOrdinal" | "griddlePlacedAt" | "movedToUpperAt"> & { temperature?: number; segments?: HeatingSegment[]; entityKey?:string; creationOrdinal?:number; griddlePlacedAt?:number|null; movedToUpperAt?:number|null };
type OverflowRestorePosition = { id:string; entityKey:string; creationOrdinal:number; plate:1|2; x:number; y:number };
type OverflowPlateRestore = { positions:Array<OverflowRestorePosition>; legacyPlate?:1|2 };
export type UndoEntry =
  | { operationId: string; type: "create"; id: string; entityKey:string; creationOrdinal:number }
  | { operationId: string; type: "move"; id: string; entityKey:string; creationOrdinal:number; from: Pick<Pancake, "plate" | "x" | "y">; overflowPlateRestore?: OverflowPlateRestore }
  | { operationId: string; type: "delete"; id: string; entityKey:string; creationOrdinal:number; pancake: Pancake; discardRecordEntityKey:string|null };
export const MAX_UNDO_HISTORY = 50;
// doughBatch is present in the Pages local snapshot. It remains optional for
// legacy server snapshots, which are outside the current supported runtime.
export interface Snapshot { revision: number; generation: number; items: Pancake[]; records: ExecutionRecord[]; completionItems: CompletionItem[]; nextPancakeOrdinal: number; nextCreationOrdinal:number; undoHistory: UndoEntry[]; doughBatch?: DoughBatchState | null; serverNow: number; serverReceivedAt?: number }
export function clockSample(serverNow:number, serverReceivedAt:number, elapsed:number) {
  const networkRtt = Math.max(0, elapsed - Math.max(0, serverNow - serverReceivedAt));
  return {networkRtt, estimatedNow:serverNow + networkRtt / 2};
}
export type Command =
  | { operationId: string; expectedGeneration?: number; type: "create"; id?: string; plate: 1 | 2; x: number; y: number; expectedDoughBatchId?: string | null; expectedNextPancakeOrdinal?: number }
  | { operationId: string; expectedGeneration?: number; type: "doughStart"; expectedDoughBatchId: null; expectedNextPancakeOrdinal: number }
  | { operationId: string; expectedGeneration?: number; type: "doughReset"; expectedDoughBatchId: string; expectedNextPancakeOrdinal: number }
  | { operationId: string; expectedGeneration?: number; type: "doughDiscardAndStart"; expectedDoughBatchId: string; expectedNextPancakeOrdinal: number }
  | { operationId: string; expectedGeneration?: number; type: "start" | "remove"; id: string; expectedVersion: number }
  | { operationId: string; expectedGeneration:number; type:"delete"; id:string; expectedVersion:number }
  | { operationId: string; expectedGeneration?: number; type: "move"; id: string; expectedVersion: number; plate: 1 | 2; x: number; y: number }
  | { operationId: string; expectedGeneration?: number; type: "adjust"; id: string; expectedVersion: number; delta: -1 | 1 }
  | { operationId: string; expectedGeneration?: number; type: "undo"; expectedUndoOperationId: string }
  | { operationId: string; expectedGeneration?: number; type: "reset" };

export const INITIAL_BOARD_GENERATION = 0;

const UUID_V4_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQUENTIAL_ID_RX = /^([1-8])-(?:([1-9])|(1[0-9])|(2[0-4]))$/;
export const MAX_PANCAKE_IDS = 8 * 24;
export const INITIAL_PANCAKE_ORDINAL = 1;

export function nextDoughBatchFirstOrdinal(nextPancakeOrdinal: number): number {
  if (!Number.isSafeInteger(nextPancakeOrdinal) || nextPancakeOrdinal < INITIAL_PANCAKE_ORDINAL || nextPancakeOrdinal > MAX_PANCAKE_IDS + 1) {
    throw new KitchenError("invalid_state", "お好み焼きIDの次番号を確認できません。");
  }
  return nextPancakeOrdinal + ((DOUGH_BATCH_SIZE - ((nextPancakeOrdinal - INITIAL_PANCAKE_ORDINAL) % DOUGH_BATCH_SIZE)) % DOUGH_BATCH_SIZE);
}

export function doughBatchStatus(batch: DoughBatchState | null | undefined, now: number): "not_started" | "active" | "expired" | "complete" {
  if (!batch) return "not_started";
  if (batch.completedAt !== null) return "complete";
  return now <= batch.deadlineAt ? "active" : "expired";
}

function normalizeDoughBatch(value: unknown, nextPancakeOrdinal: number): DoughBatchState | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("保存データの生地タイマーが正しくありません。");
  const candidate = value as Record<string, unknown>;
  const first = candidate.firstPancakeOrdinal;
  const startedAt = candidate.startedAt;
  const deadlineAt = candidate.deadlineAt;
  const rawPlacedKeys = candidate.placedEntityKeys;
  const rawPlacedIds = candidate.placedIds;
  const completedAt = candidate.completedAt;
  if (!isUuidV4(candidate.batchId)
    || !Number.isSafeInteger(first) || (first as number) < 1 || (first as number) > MAX_PANCAKE_IDS - DOUGH_BATCH_SIZE + 1
    || ((first as number) - INITIAL_PANCAKE_ORDINAL) % DOUGH_BATCH_SIZE !== 0
    || !Number.isSafeInteger(startedAt) || (startedAt as number) < 0
    || !Number.isSafeInteger(deadlineAt) || deadlineAt !== (startedAt as number) + DOUGH_BATCH_DURATION
    || !(Array.isArray(rawPlacedKeys) || Array.isArray(rawPlacedIds))
    || (Array.isArray(rawPlacedKeys) && Array.isArray(rawPlacedIds))
    || (Array.isArray(rawPlacedKeys) ? rawPlacedKeys.length : (rawPlacedIds as unknown[]).length) > DOUGH_BATCH_SIZE
    || !(completedAt === null || (Number.isSafeInteger(completedAt) && (completedAt as number) >= (startedAt as number) && (completedAt as number) <= (deadlineAt as number)))
    || ((Array.isArray(rawPlacedKeys) ? rawPlacedKeys.length : (rawPlacedIds as unknown[]).length) === DOUGH_BATCH_SIZE) !== (completedAt !== null)) {
    throw new Error("保存データの生地タイマーが正しくありません。");
  }
  const placedValues = (Array.isArray(rawPlacedKeys) ? rawPlacedKeys : rawPlacedIds) as unknown[];
  const normalizedKeys: string[] = [];
  const seen = new Set<string>();
  placedValues.forEach((value: unknown, index: number) => {
    const isLegacyId = Array.isArray(rawPlacedIds);
    const key = isLegacyId && typeof value === "string" && isPancakeId(value)
      ? legacyEntityKey(value)
      : value;
    if ((isLegacyId && pancakeOrdinalForId(value as string) !== (first as number) + index)
      || !isEntityKey(key) || seen.has(key)) {
      throw new Error("保存データの生地配置履歴が正しくありません。");
    }
    seen.add(key);
    normalizedKeys.push(key);
  });
  if (nextPancakeOrdinal !== (first as number) + normalizedKeys.length) {
    throw new Error("保存データの生地配置数と次IDが一致しません。");
  }
  return {
    batchId:candidate.batchId,
    firstPancakeOrdinal:first as number,
    startedAt:startedAt as number,
    deadlineAt:deadlineAt as number,
    placedEntityKeys:normalizedKeys,
    completedAt:completedAt as number | null,
  };
}

export function isPancakeId(value: unknown): value is string {
  return typeof value === "string" && (UUID_V4_RX.test(value) || SEQUENTIAL_ID_RX.test(value));
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RX.test(value);
}

function legacyEntityKey(id:string):string {
  if (!isPancakeId(id)) throw new Error("保存データのお好み焼きIDが正しくありません。");
  return `legacy:${encodeURIComponent(id)}`;
}

export function isEntityKey(value:unknown):value is string {
  if (isUuidV4(value)) return true;
  if (typeof value !== "string" || !value.startsWith("legacy:")) return false;
  try {
    const id = decodeURIComponent(value.slice("legacy:".length));
    return isPancakeId(id) && legacyEntityKey(id) === value;
  } catch {
    return false;
  }
}

function entityKeyFor(id:string, candidate:unknown):string {
  if (candidate === undefined) return legacyEntityKey(id);
  if (!isEntityKey(candidate)) throw new Error("保存データのお好み焼き内部IDが正しくありません。");
  return candidate;
}

function creationOrdinalFor(id:string, candidate:unknown):number {
  if (candidate === undefined) return pancakeOrdinalForId(id) ?? 0;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new Error("保存データのお好み焼き作成順が正しくありません。");
  }
  return candidate as number;
}

export function pancakeIdForOrdinal(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_PANCAKE_IDS) {
    throw new KitchenError("id_capacity", "お好み焼きIDの配置上限（192個）に達しました。新しい楕円を配置できません。");
  }
  const row = Math.floor((ordinal - 1) / 24) + 1;
  const column = ((ordinal - 1) % 24) + 1;
  return `${row}-${column}`;
}

export function pancakeOrdinalForId(id: string): number | null {
  const match = SEQUENTIAL_ID_RX.exec(id);
  if (!match) return null;
  const row = Number(match[1]);
  const column = Number(match[2] ?? match[3] ?? match[4]);
  return (row - 1) * 24 + column;
}

export function normalizePancake(item: StoredPancake): Pancake {
  if (!isPancakeId(item.id)) throw new Error("保存データのお好み焼きIDが正しくありません。");
  if ((item.plate !== 1 && item.plate !== 2) || !savedPositionIsValid(item.x, item.y)) {
    throw new Error("保存データのお好み焼き位置が正しくありません。");
  }
  const validEventTime = (value: unknown) => value === undefined || value === null
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (!validEventTime(item.griddlePlacedAt) || !validEventTime(item.movedToUpperAt)) {
    throw new Error("保存データの鉄板イベント時刻が正しくありません。");
  }
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
    entityKey:entityKeyFor(item.id, item.entityKey),
    creationOrdinal:creationOrdinalFor(item.id, item.creationOrdinal),
    duration: TIMER_DURATION,
    griddlePlacedAt:item.griddlePlacedAt ?? null,
    movedToUpperAt:item.movedToUpperAt ?? null,
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
    if (!isPancakeId(candidate.id) || !Number.isFinite(candidate.startedAt) || !Number.isFinite(candidate.collectedAt)
      || (candidate.collectedAt as number) < (candidate.startedAt as number) || !Array.isArray(candidate.segments) || candidate.segments.length === 0) {
      throw new Error("保存データの実行記録が正しくありません。");
    }
    const entityKey = entityKeyFor(candidate.id, candidate.entityKey);
    const creationOrdinal = creationOrdinalFor(candidate.id, candidate.creationOrdinal);
    const nullableEventTime = (value: unknown) => value === undefined || value === null
      || (typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (!nullableEventTime(candidate.griddlePlacedAt) || !nullableEventTime(candidate.movedToUpperAt)) {
      throw new Error("保存データの鉄板イベント時刻が正しくありません。");
    }
    const eventTimes = {
      griddlePlacedAt:candidate.griddlePlacedAt === undefined ? null : candidate.griddlePlacedAt as number | null,
      movedToUpperAt:candidate.movedToUpperAt === undefined ? null : candidate.movedToUpperAt as number | null,
    };
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
        entityKey,
        creationOrdinal,
        ...eventTimes,
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
      return {id:candidate.id, entityKey, creationOrdinal, ...eventTimes, startedAt:candidate.startedAt as number, collectedAt:candidate.collectedAt as number, segments, ...service};
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
      return {id:candidate.id, entityKey, creationOrdinal, ...eventTimes, startedAt:candidate.startedAt as number, collectedAt:candidate.collectedAt as number, segments, ...service};
  });
}

export function normalizeCompletionItems(value: unknown, records: readonly ExecutionRecord[]): CompletionItem[] {
  if (!Array.isArray(value)) throw new Error("保存データの完成ボックスが正しくありません。");
  const entityKeys = new Set<string>();
  const recordByKey = new Map(records.map(record => [record.entityKey, record]));
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("保存データの完成ボックスが正しくありません。");
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !isPancakeId(candidate.id)) throw new Error("保存データの完成ボックス項目が正しくありません。");
    const entityKey = entityKeyFor(candidate.id, candidate.entityKey);
    const record = recordByKey.get(entityKey);
    const creationOrdinal = record?.creationOrdinal ?? creationOrdinalFor(candidate.id, candidate.creationOrdinal);
    if (!Number.isSafeInteger(candidate.version) || (candidate.version as number) < 1
      || entityKeys.has(entityKey) || !record || (candidate.creationOrdinal !== undefined && creationOrdinal !== candidate.creationOrdinal)
      || record.serveTimerStartedAt === null
      || record.servedAt !== null || record.unavailableAt !== null || record.unavailableReason !== null) {
      throw new Error("保存データの完成ボックス項目が正しくありません。");
    }
    entityKeys.add(entityKey);
    return {id:candidate.id, entityKey, creationOrdinal, version:candidate.version as number};
  });
}

export interface NormalizedBoardData {
  generation: number;
  items: Pancake[];
  records: ExecutionRecord[];
  completionItems: CompletionItem[];
  nextPancakeOrdinal: number;
  nextCreationOrdinal:number;
  undoHistory: UndoEntry[];
  doughBatch?: DoughBatchState | null;
}

function assignEntityOrdinals(
  items: Pancake[],
  records: ExecutionRecord[],
  completionItems: CompletionItem[],
  undoHistory: UndoEntry[],
  requestedNextOrdinal: unknown,
  nextPancakeOrdinal: number,
) {
  const byKey = new Map<string, {id:string; ordinal:number}>();
  const register = (entityKey:string, id:string, ordinal:number) => {
    const current = byKey.get(entityKey);
    if (!current) {
      byKey.set(entityKey, {id, ordinal});
      return;
    }
    if (current.ordinal > 0 && ordinal > 0 && current.ordinal !== ordinal) {
      throw new Error("保存データで同じお好み焼きの作成順が一致しません。");
    }
    if (current.ordinal === 0 && ordinal > 0) current.ordinal = ordinal;
  };
  for (const record of records) register(record.entityKey, record.id, record.creationOrdinal);
  for (const item of items) register(item.entityKey, item.id, item.creationOrdinal);
  for (const item of completionItems) register(item.entityKey, item.id, item.creationOrdinal);
  for (const entry of undoHistory) {
    register(entry.entityKey, entry.id, entry.creationOrdinal);
    if (entry.type === "delete") register(entry.pancake.entityKey, entry.pancake.id, entry.pancake.creationOrdinal);
    if (entry.type === "move" && entry.overflowPlateRestore) {
      for (const position of entry.overflowPlateRestore.positions) register(position.entityKey, position.id, position.creationOrdinal);
    }
  }

  const usedOrdinals = new Map<number, string>();
  for (const [entityKey, entity] of byKey) {
    if (entity.ordinal <= 0) continue;
    const prior = usedOrdinals.get(entity.ordinal);
    if (prior && prior !== entityKey) throw new Error("保存データに重複したお好み焼き作成順があります。");
    usedOrdinals.set(entity.ordinal, entityKey);
  }
  let greatestOrdinal = Math.max(0, ...usedOrdinals.keys());
  for (const [entityKey, entity] of byKey) {
    if (entity.ordinal > 0) continue;
    greatestOrdinal += 1;
    if (!Number.isSafeInteger(greatestOrdinal)) throw new Error("お好み焼き作成順が上限に達しています。");
    entity.ordinal = greatestOrdinal;
    usedOrdinals.set(greatestOrdinal, entityKey);
  }
  if (requestedNextOrdinal !== undefined
    && (!Number.isSafeInteger(requestedNextOrdinal) || (requestedNextOrdinal as number) < 1 || (requestedNextOrdinal as number) <= greatestOrdinal)) {
    throw new Error("保存データのお好み焼き作成順カウンターが正しくありません。");
  }
  const nextCreationOrdinal = requestedNextOrdinal === undefined
    ? Math.max(greatestOrdinal + 1, nextPancakeOrdinal)
    : requestedNextOrdinal as number;
  if (!Number.isSafeInteger(nextCreationOrdinal) || nextCreationOrdinal < 1) {
    throw new Error("保存データのお好み焼き作成順カウンターが正しくありません。");
  }
  const withOrdinal = <T extends {entityKey:string; creationOrdinal:number}>(entity:T):T => {
    const ordinal = byKey.get(entity.entityKey)?.ordinal;
    if (!ordinal) throw new Error("保存データのお好み焼き作成順を解決できません。");
    return {...entity, creationOrdinal:ordinal};
  };
  const normalizedItems = items.map(withOrdinal);
  const normalizedRecords = records.map(withOrdinal);
  const normalizedCompletion = completionItems.map(withOrdinal);
  const normalizedUndo = undoHistory.map(entry => {
    const common = withOrdinal(entry);
    if (entry.type === "delete") return {...common, pancake:withOrdinal(entry.pancake)};
    return common;
  });
  return {
    items:normalizedItems,
    records:normalizedRecords,
    completionItems:normalizedCompletion,
    undoHistory:normalizedUndo,
    nextCreationOrdinal,
  };
}

function relabelEntities(items:Pancake[], records:ExecutionRecord[], completionItems:CompletionItem[], undoHistory:UndoEntry[]) {
  const entityByKey = new Map<string, {id:string; creationOrdinal:number}>();
  for (const entity of [...items, ...records]) {
    if (!isEntityKey(entity.entityKey) || !Number.isSafeInteger(entity.creationOrdinal) || entity.creationOrdinal < 1
      || entityByKey.has(entity.entityKey)) {
      throw new Error("保存データのお好み焼き内部IDまたは関連付けが正しくありません。");
    }
    entityByKey.set(entity.entityKey, {id:entity.id, creationOrdinal:entity.creationOrdinal});
  }
  if (entityByKey.size > MAX_PANCAKE_IDS) {
    throw new KitchenError("id_capacity", "保存データに表示上限（192個）を超えるお好み焼きがあります。保存データは変更していません。");
  }
  const entities = [...entityByKey.entries()].sort((a, b) => a[1].creationOrdinal - b[1].creationOrdinal);
  for (let index = 1; index < entities.length; index += 1) {
    if (entities[index - 1][1].creationOrdinal === entities[index][1].creationOrdinal) {
      throw new Error("保存データに重複したお好み焼き作成順があります。");
    }
  }
  const idByKey = new Map<string, string>();
  entities.forEach(([entityKey], index) => idByKey.set(entityKey, pancakeIdForOrdinal(index + 1)));
  for (const item of completionItems) {
    if (!entityByKey.has(item.entityKey)) throw new Error("完成ボックスのお好み焼き内部IDを実行記録から照合できません。");
  }
  const changed = [...items, ...records, ...completionItems].some(entity => entity.id !== idByKey.get(entity.entityKey));
  const relabel = <T extends {id:string; entityKey:string}>(entity:T):T => {
    const id = idByKey.get(entity.entityKey);
    if (!id) return entity;
    return {...entity, id};
  };
  const normalizedUndo = undoHistory.map(entry => {
    const id = idByKey.get(entry.entityKey) ?? entry.id;
    if (entry.type === "create") return {...entry, id};
    if (entry.type === "move") {
      const overflowPlateRestore = entry.overflowPlateRestore
        ? {...entry.overflowPlateRestore, positions:entry.overflowPlateRestore.positions.map(position => ({...position, id:idByKey.get(position.entityKey) ?? position.id}))}
        : undefined;
      return {...entry, id, ...(overflowPlateRestore ? {overflowPlateRestore} : {})};
    }
    const pancake = relabel(entry.pancake);
    return {...entry, id, pancake};
  });
  return {
    changed,
    items:items.map(relabel),
    records:records.map(relabel),
    completionItems:completionItems.map(relabel),
    undoHistory:normalizedUndo,
  };
}

function validateStrictEntityMetadata(input:{
  items:readonly StoredPancake[];
  records:unknown;
  completionItems:unknown;
  undoHistory?:unknown;
  doughBatch?:unknown;
  nextCreationOrdinal?:unknown;
}):void {
  const isObject = (value:unknown):value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const validEntity = (value:unknown) => isObject(value)
    && isEntityKey(value.entityKey)
    && Number.isSafeInteger(value.creationOrdinal)
    && (value.creationOrdinal as number) >= 1;
  if (!Number.isSafeInteger(input.nextCreationOrdinal) || (input.nextCreationOrdinal as number) < 1
    || !input.items.every(validEntity)
    || !Array.isArray(input.records) || !input.records.every(validEntity)
    || !Array.isArray(input.completionItems) || !input.completionItems.every(validEntity)
    || !Array.isArray(input.undoHistory)) {
    throw new Error("schema 8の内部ID情報が不足しています。");
  }
  for (const entry of input.undoHistory) {
    if (!validEntity(entry)) throw new Error("schema 8の操作取り消し内部IDが不足しています。");
    if (entry.type === "delete" && (!validEntity(entry.pancake)
      || !(entry.discardRecordEntityKey === null || isEntityKey(entry.discardRecordEntityKey)))) {
      throw new Error("schema 8の削除取り消し内部IDが不足しています。");
    }
    if (entry.type === "move" && entry.overflowPlateRestore !== undefined) {
      const restore = entry.overflowPlateRestore;
      if (!isObject(restore) || !Array.isArray(restore.positions) || !restore.positions.every(validEntity)) {
        throw new Error("schema 8の移動取り消し内部IDが不足しています。");
      }
    }
  }
  if (input.doughBatch !== null && input.doughBatch !== undefined) {
    if (!isObject(input.doughBatch) || !Array.isArray(input.doughBatch.placedEntityKeys)
      || Object.prototype.hasOwnProperty.call(input.doughBatch, "placedIds")) {
      throw new Error("schema 8の生地配置内部IDが不足しています。");
    }
  }
}

function validateUndoEntityReferences(items:Pancake[], records:ExecutionRecord[], completionItems:CompletionItem[], undoHistory:UndoEntry[]):void {
  const itemKeys = new Set(items.map(item => item.entityKey));
  const recordKeys = new Set(records.map(record => record.entityKey));
  const completionKeys = new Set(completionItems.map(item => item.entityKey));
  const deleteUndoKeys = new Set(undoHistory.filter((entry):entry is Extract<UndoEntry, {type:"delete"}> => entry.type === "delete").map(entry => entry.entityKey));
  for (const entry of undoHistory) {
    if (entry.type === "create" && ((!itemKeys.has(entry.entityKey) && !deleteUndoKeys.has(entry.entityKey))
      || (recordKeys.has(entry.entityKey) && !deleteUndoKeys.has(entry.entityKey)) || completionKeys.has(entry.entityKey))) {
      throw new Error("配置Undo履歴のお好み焼き内部IDを盤面から照合できません。");
    }
    if (entry.type === "move" && !itemKeys.has(entry.entityKey) && !deleteUndoKeys.has(entry.entityKey)) {
      throw new Error("移動Undo履歴のお好み焼き内部IDを盤面から照合できません。");
    }
    if (entry.type === "move" && entry.overflowPlateRestore
      && entry.overflowPlateRestore.positions.some(position => !itemKeys.has(position.entityKey) && !deleteUndoKeys.has(position.entityKey))) {
      throw new Error("過密配置Undo履歴のお好み焼き内部IDを盤面から照合できません。");
    }
    if (entry.type === "delete" && (itemKeys.has(entry.entityKey)
      || (entry.discardRecordEntityKey === null ? recordKeys.has(entry.entityKey) : !recordKeys.has(entry.discardRecordEntityKey)))) {
      throw new Error("削除Undo履歴のお好み焼き内部IDを保存状態から照合できません。");
    }
  }
}

function savedPositionIsValid(x: unknown, y: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x)
    && typeof y === "number" && Number.isFinite(y)
    && x >= LEGACY_OVAL_RX + 0.02 && x <= 1 - LEGACY_OVAL_RX - 0.02
    && y >= LEGACY_OVAL_RY + 0.02 && y <= 1 - LEGACY_OVAL_RY - 0.02;
}

function hasGridCapacity(items: readonly Pick<Pancake, "plate">[]): boolean {
  return ([1, 2] as const).every(plate => items.filter(item => item.plate === plate).length <= GRID_CELLS_PER_PLATE);
}

function pointDistanceSquared(a: {x:number;y:number}, b: {x:number;y:number}): number {
  // Compare in the actual 1600×900 SVG coordinate space, not normalized space.
  return ((a.x - b.x) * 1600) ** 2 + ((a.y - b.y) * 900) ** 2;
}

export function nearestGridCell(x: number, y: number): GridCell {
  const point = {x, y};
  let nearest = GRID_CELLS[0];
  let distance = pointDistanceSquared(point, nearest);
  for (const cell of GRID_CELLS.slice(1)) {
    const candidateDistance = pointDistanceSquared(point, cell);
    // GRID_CELLS is row-major, so ties naturally favor top-left first.
    if (candidateDistance < distance) {
      nearest = cell;
      distance = candidateDistance;
    }
  }
  return nearest;
}

export function gridCellAt(x: number, y: number): GridCell {
  return nearestGridCell(x, y);
}

function exactGridCell(x: number, y: number): GridCell | undefined {
  return GRID_CELLS.find(cell => Math.abs(cell.x - x) < 0.000001 && Math.abs(cell.y - y) < 0.000001);
}

function assignPlateCells(items: readonly Pancake[], plate: 1 | 2): Map<string, GridCell> {
  const occupied = new Set<number>();
  const assignments = new Map<string, GridCell>();
  const sorted = items.filter(item => item.plate === plate).sort((a, b) =>
    a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const pending: Pancake[] = [];
  for (const item of sorted) {
    if (occupied.size >= GRID_CELLS_PER_PLATE) break;
    const exact = exactGridCell(item.x, item.y);
    if (exact && !occupied.has(exact.index)) {
      occupied.add(exact.index);
      assignments.set(item.id, exact);
      continue;
    }
    pending.push(item);
  }
  for (const item of pending) {
    if (occupied.size >= GRID_CELLS_PER_PLATE) break;
    const cell = nearestFreeCell(item.x, item.y, occupied);
    occupied.add(cell.index);
    assignments.set(item.id, cell);
  }
  return assignments;
}

export function isGridCellOccupied(items: readonly Pancake[], plate: 1 | 2, cellIndex: number, exceptId?: string): boolean {
  const cell = GRID_CELLS[cellIndex];
  if (!cell) return true;
  const remaining = items.filter(item => item.id !== exceptId);
  if (remaining.filter(item => item.plate === plate).length > GRID_CELLS_PER_PLATE) return true;
  return [...assignPlateCells(remaining, plate).values()].some(assigned => assigned.index === cellIndex);
}

export function isGridCellActuallyOccupied(items: readonly Pancake[], plate: 1 | 2, cellIndex: number, exceptId?: string): boolean {
  const cell = GRID_CELLS[cellIndex];
  if (!cell) return true;
  return items.some(item => item.id !== exceptId && item.plate === plate && overlaps(item, cell));
}

export function isGridOverCapacity(items: readonly Pick<Pancake, "plate">[]): boolean {
  return !hasGridCapacity(items);
}

export function isPlateOverCapacity(items: readonly Pick<Pancake, "plate">[], plate: 1 | 2): boolean {
  return items.filter(item => item.plate === plate).length > GRID_CELLS_PER_PLATE;
}

export function gridDropBlockReason(items: readonly Pancake[], plate:1|2, cellIndex:number, exceptId?:string): "occupied"|"over_capacity"|null {
  if (isPlateOverCapacity(items, plate)) return "over_capacity";
  if (isGridCellOccupied(items, plate, cellIndex, exceptId)) return "occupied";
  if (isGridOverCapacity(items)) {
    const cell = GRID_CELLS[cellIndex];
    if (!cell || items.some(item => item.id !== exceptId && item.plate === plate && overlaps(item, cell))) return "occupied";
  }
  return null;
}

export type GridMoveBlockReason = "missing"|"source_not_bottom"|"different_plate"|"wrong_row"|"different_column"|"occupied"|"over_capacity";

export function gridMoveSourceBlockReason(items: readonly Pancake[], id: string): "missing"|"source_not_bottom"|null {
  const item = items.find(candidate => candidate.id === id);
  if (!item) return "missing";
  return nearestGridCell(item.x, item.y).row === GRID_ROWS - 1 ? null : "source_not_bottom";
}

export function gridMoveBlockReason(items: readonly Pancake[], id: string, plate:1|2, cellIndex:number): GridMoveBlockReason|null {
  const item = items.find(candidate => candidate.id === id);
  if (!item) return "missing";
  const source = nearestGridCell(item.x, item.y);
  if (source.row !== GRID_ROWS - 1) return "source_not_bottom";
  const destination = GRID_CELLS[cellIndex];
  if (plate !== item.plate) return "different_plate";
  if (!destination || destination.row !== source.row - 1) return "wrong_row";
  if (destination.column !== source.column) return "different_column";
  return gridDropBlockReason(items, plate, cellIndex, id);
}

function nearestFreeCell(x: number, y: number, occupied: Set<number>): GridCell {
  let nearest: GridCell | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const cell of GRID_CELLS) {
    if (occupied.has(cell.index)) continue;
    const candidateDistance = pointDistanceSquared({x,y}, cell);
    if (candidateDistance < distance) {
      nearest = cell;
      distance = candidateDistance;
    }
  }
  if (!nearest) throw new Error("鉄板の空きマスを割り当てられません。");
  return nearest;
}

function canonicalizeItemPositions(items: readonly Pancake[]): Pancake[] {
  const positions = new Map([...assignPlateCells(items, 1), ...assignPlateCells(items, 2)]);
  return items.map(item => {
    const cell = positions.get(item.id);
    return cell ? {...item, x:cell.x, y:cell.y} : item;
  });
}

function normalizeUndoHistory(value: unknown, records: readonly ExecutionRecord[], canonicalizePositions: boolean): UndoEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_UNDO_HISTORY) {
    throw new Error("保存データの操作取り消し履歴が正しくありません。");
  }
  const operationIds = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("保存データの操作取り消し履歴が正しくありません。");
    }
    const entry = raw as Record<string, unknown>;
    if (!isUuidV4(entry.operationId) || operationIds.has(entry.operationId) || !isPancakeId(entry.id)) {
      throw new Error("保存データの操作取り消し履歴が正しくありません。");
    }
    operationIds.add(entry.operationId);
    const entityKey = entityKeyFor(entry.id, entry.entityKey);
    const creationOrdinal = creationOrdinalFor(entry.id, entry.creationOrdinal);
    if (entry.type === "create") return {operationId:entry.operationId, type:entry.type, id:entry.id, entityKey, creationOrdinal};
    if (entry.type === "move") {
      const from = entry.from;
      if (!from || typeof from !== "object" || Array.isArray(from)) {
        throw new Error("保存データの移動取り消し履歴が正しくありません。");
      }
      const position = from as Record<string, unknown>;
      if ((position.plate !== 1 && position.plate !== 2) || !savedPositionIsValid(position.x, position.y)) {
        throw new Error("保存データの移動取り消し履歴が正しくありません。");
      }
      let overflowPlateRestore: OverflowPlateRestore | undefined;
      if (entry.overflowPlateRestore !== undefined) {
        const rawRestore = entry.overflowPlateRestore;
        if (!rawRestore || typeof rawRestore !== "object" || Array.isArray(rawRestore)) {
          throw new Error("保存データの過密鉄板Undo履歴が正しくありません。");
        }
        const saved = rawRestore as Record<string, unknown>;
        const legacyPlateMarker = saved.legacyPlate;
        if (legacyPlateMarker !== undefined && legacyPlateMarker !== 1 && legacyPlateMarker !== 2) {
          throw new Error("保存データの過密鉄板Undo履歴が正しくありません。");
        }
        if (saved.plate !== undefined && saved.plate !== 1 && saved.plate !== 2) {
          throw new Error("保存データの過密鉄板Undo履歴が正しくありません。");
        }
        if (!Array.isArray(saved.positions) || saved.positions.length < 1 || saved.positions.length > MAX_PANCAKE_IDS) {
          throw new Error("保存データの過密鉄板Undo履歴が正しくありません。");
        }
        const positionIds = new Set<string>();
        let restoreFormat: "legacy-raw"|"legacy-marked"|"full"|null = null;
        const positions = saved.positions.map((rawPosition: unknown) => {
          if (!rawPosition || typeof rawPosition !== "object" || Array.isArray(rawPosition)) {
            throw new Error("保存データの過密鉄板Undo履歴が正しくありません。");
          }
          const savedPosition = rawPosition as Record<string, unknown>;
          const isLegacyPosition = savedPosition.plate === undefined;
          const isMarkedLegacyRestore = legacyPlateMarker !== undefined;
          const format = isLegacyPosition ? "legacy-raw" : isMarkedLegacyRestore ? "legacy-marked" : "full";
          const plate = isLegacyPosition ? saved.plate : savedPosition.plate;
          if ((restoreFormat !== null && restoreFormat !== format)
            || (plate !== 1 && plate !== 2)
            || (isLegacyPosition && (legacyPlateMarker !== undefined || plate !== position.plate))
            || (isMarkedLegacyRestore && plate !== legacyPlateMarker)
            || ((format === "legacy-marked" || format === "full") && saved.plate !== undefined)) {
            throw new Error("保存データの過密鉄板Undo履歴が正しくありません。");
          }
          restoreFormat = format;
          if (!isPancakeId(savedPosition.id) || positionIds.has(savedPosition.id)
            || !savedPositionIsValid(savedPosition.x, savedPosition.y)) {
            throw new Error("保存データの過密鉄板Undo履歴が正しくありません。");
          }
          positionIds.add(savedPosition.id);
          return {id:savedPosition.id, entityKey:entityKeyFor(savedPosition.id, savedPosition.entityKey), creationOrdinal:creationOrdinalFor(savedPosition.id, savedPosition.creationOrdinal), plate:plate as 1|2, x:savedPosition.x as number, y:savedPosition.y as number};
        });
        if (!positionIds.has(entry.id)) throw new Error("保存データの過密鉄板Undo履歴が対象IDと一致しません。");
        overflowPlateRestore = {
          positions,
          ...(restoreFormat === "legacy-raw"
            ? {legacyPlate:saved.plate as 1|2}
            : restoreFormat === "legacy-marked"
              ? {legacyPlate:legacyPlateMarker as 1|2}
              : {}),
        };
      }
      const cell = canonicalizePositions && !overflowPlateRestore ? nearestGridCell(position.x as number, position.y as number) : null;
      return {
        operationId:entry.operationId,
        type:entry.type,
        id:entry.id,
        entityKey,
        creationOrdinal,
        from:{plate:position.plate, x:cell?.x ?? position.x as number, y:cell?.y ?? position.y as number},
        ...(overflowPlateRestore ? {overflowPlateRestore} : {}),
      };
    }
    if (entry.type === "delete") {
      if (!entry.pancake || typeof entry.pancake !== "object" || Array.isArray(entry.pancake)) {
        throw new Error("保存データの削除取り消し履歴が正しくありません。");
      }
      const savedPancake = entry.pancake as Record<string, unknown>;
      if ((savedPancake.plate !== 1 && savedPancake.plate !== 2)
        || !savedPositionIsValid(savedPancake.x, savedPancake.y)
        || typeof savedPancake.duration !== "number" || !Number.isSafeInteger(savedPancake.duration)
        || (savedPancake.temperature !== undefined && !Number.isSafeInteger(savedPancake.temperature))
        || !(savedPancake.startedAt === null || (typeof savedPancake.startedAt === "number" && Number.isFinite(savedPancake.startedAt) && savedPancake.startedAt >= 0))
        || !Number.isSafeInteger(savedPancake.version) || (savedPancake.version as number) < 1) {
        throw new Error("保存データの削除取り消し履歴が正しくありません。");
      }
      let pancake: Pancake;
      try {
        pancake = normalizePancake(entry.pancake as StoredPancake);
      } catch {
        throw new Error("保存データの削除取り消し履歴が正しくありません。");
      }
      const pancakeEntityKey = entityKeyFor(pancake.id, savedPancake.entityKey);
      const discardRecordEntityKey = entry.discardRecordEntityKey !== undefined
        ? (entry.discardRecordEntityKey === null || isEntityKey(entry.discardRecordEntityKey) ? entry.discardRecordEntityKey as string|null : undefined)
        : entry.discardRecordId === null ? null
          : typeof entry.discardRecordId === "string" ? legacyEntityKey(entry.discardRecordId) : undefined;
      if (pancake.id !== entry.id || pancakeEntityKey !== entityKey
        || (discardRecordEntityKey === undefined)
        || !(discardRecordEntityKey === null || discardRecordEntityKey === entityKey)) {
        throw new Error("保存データの削除取り消し履歴が正しくありません。");
      }
      pancake = {...pancake, entityKey, creationOrdinal};
      if (canonicalizePositions) {
        const cell = nearestGridCell(pancake.x, pancake.y);
        pancake = {...pancake, x:cell.x, y:cell.y};
      }
      if (discardRecordEntityKey !== null && !records.some(record => record.entityKey === discardRecordEntityKey
        && record.unavailableReason === PLATE_DISCARD_REASON && record.serveTimerStartedAt === null)) {
        throw new Error("保存データの盤外破棄記録を取り消し履歴と照合できません。");
      }
      return {operationId:entry.operationId, type:entry.type, id:entry.id, entityKey, creationOrdinal, pancake, discardRecordEntityKey};
    }
    throw new Error("保存データの操作取り消し履歴が正しくありません。");
  });
}

/**
 * Canonicalize a saved board and migrate live legacy UUIDs to placement-order
 * IDs. Completed historical records keep their old IDs unless they still
 * belong to a pancake currently waiting in the completion box.
 */
export function normalizeBoardData(input: {
  items: readonly StoredPancake[];
  records: unknown;
  completionItems: unknown;
  generation?: unknown;
  nextPancakeOrdinal?: unknown;
  nextCreationOrdinal?:unknown;
  undoHistory?: unknown;
  doughBatch?: unknown;
  strictPublicIds?:boolean;
  strictEntityMetadata?:boolean;
}): NormalizedBoardData {
  if (input.strictEntityMetadata) validateStrictEntityMetadata(input);
  const generation = input.generation === undefined ? INITIAL_BOARD_GENERATION : input.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < INITIAL_BOARD_GENERATION) {
    throw new Error("保存データの盤面世代が正しくありません。");
  }
  const records = normalizeExecutionRecords(input.records);
  const initialCompletion = normalizeCompletionItems(input.completionItems, records);
  let items = normalizePancakes(input.items);
  const originalIds = [
    ...items.map(item => item.id),
    ...records.map(record => record.id),
    ...initialCompletion.map(item => item.id),
  ];
  const greatestSavedOrdinal = originalIds.reduce((greatest, id) => Math.max(greatest, pancakeOrdinalForId(id) ?? 0), 0);
  const hasIdentityMetadata = (value:unknown):boolean => typeof value === "object" && value !== null && !Array.isArray(value)
    && isEntityKey((value as Record<string, unknown>).entityKey)
    && Number.isSafeInteger((value as Record<string, unknown>).creationOrdinal)
    && ((value as Record<string, unknown>).creationOrdinal as number) >= 1;
  const rawRecords = Array.isArray(input.records) ? input.records : [];
  const rawCompletionItems = Array.isArray(input.completionItems) ? input.completionItems : [];
  const rawIdentityEntities:unknown[] = [...input.items, ...rawRecords, ...rawCompletionItems];
  const identityMetadataPresent = input.nextCreationOrdinal !== undefined
    || rawIdentityEntities.length === 0
    || rawIdentityEntities.every(hasIdentityMetadata);
  let nextPancakeOrdinal: number;
  if (input.nextPancakeOrdinal === undefined) {
    nextPancakeOrdinal = Math.max(INITIAL_PANCAKE_ORDINAL, greatestSavedOrdinal + 1);
  } else {
    if (!Number.isSafeInteger(input.nextPancakeOrdinal)
      || (input.nextPancakeOrdinal as number) < INITIAL_PANCAKE_ORDINAL
      || (input.nextPancakeOrdinal as number) > MAX_PANCAKE_IDS + 1
      || (!identityMetadataPresent && (input.nextPancakeOrdinal as number) <= greatestSavedOrdinal)) {
      throw new Error("保存データのお好み焼き採番カウンターが正しくありません。");
    }
    nextPancakeOrdinal = input.nextPancakeOrdinal as number;
  }

  const overCapacity = !hasGridCapacity(items);
  if (!overCapacity) items = canonicalizeItemPositions(items);
  const undoHistory = normalizeUndoHistory(input.undoHistory, records, !overCapacity);
  const assigned = assignEntityOrdinals(items, records, initialCompletion, undoHistory, input.nextCreationOrdinal, nextPancakeOrdinal);
  items = assigned.items;
  const normalizedRecords = assigned.records;
  const normalizedCompletion = assigned.completionItems;
  const normalizedUndo = assigned.undoHistory;
  validateUndoEntityReferences(items, normalizedRecords, normalizedCompletion, normalizedUndo);
  const dense = relabelEntities(items, normalizedRecords, normalizedCompletion, normalizedUndo);
  if (input.strictPublicIds && dense.changed) throw new Error("保存データの公開IDが連続していません。");
  const doughBatch = normalizeDoughBatch(input.doughBatch, nextPancakeOrdinal);
  return {
    generation:generation as number,
    items:dense.items,
    records:dense.records,
    completionItems:dense.completionItems,
    nextPancakeOrdinal,
    nextCreationOrdinal:assigned.nextCreationOrdinal,
    undoHistory:dense.undoHistory,
    ...(doughBatch === undefined ? {} : {doughBatch}),
  };
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
function normalizeChangedBoard(snapshot: Snapshot): Snapshot {
  const board = normalizeBoardData({
    items:snapshot.items,
    records:snapshot.records,
    completionItems:snapshot.completionItems,
    generation:snapshot.generation,
    nextPancakeOrdinal:snapshot.nextPancakeOrdinal,
    nextCreationOrdinal:snapshot.nextCreationOrdinal,
    undoHistory:snapshot.undoHistory,
    ...(Object.prototype.hasOwnProperty.call(snapshot, "doughBatch") ? {doughBatch:snapshot.doughBatch} : {}),
  });
  return {...snapshot, ...board};
}
function requireGridCapacity(items: readonly Pancake[]): void {
  if (isGridOverCapacity(items)) {
    throw new KitchenError("grid_over_capacity", "鉄板の既存配置数が6枚以下になるまで、新しい楕円は配置できません。焼き上がった楕円を完成ボックスへ移してください。");
  }
}
export function overlaps(a: {x: number; y: number}, b: {x: number; y: number}) {
  return ((a.x - b.x) / (2 * OVAL_RX + 0.025)) ** 2 + ((a.y - b.y) / (2 * OVAL_RY + 0.025)) ** 2 < 1;
}
function overlapsLegacy(a: {x:number;y:number}, b: {x:number;y:number}): boolean {
  return ((a.x - b.x) / (2 * LEGACY_OVAL_RX + 0.025)) ** 2
    + ((a.y - b.y) / (2 * LEGACY_OVAL_RY + 0.025)) ** 2 < 1;
}
export function gesture(dx: number, dy: number, maximumDistance: number) {
  if (maximumDistance < 10) return "tap";
  if (Math.abs(dx) >= 30 && Math.abs(dx) > Math.abs(dy) * 1.4) return dx > 0 ? "right" : "left";
  if (dy <= -30 && -dy > Math.abs(dx) * 1.4) return "up";
  return "none";
}
export function parseCommand(input: unknown): Command {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KitchenError("invalid", "操作内容を確認してください。", 400);
  const c = input as Record<string, unknown>;
  if (!isUuidV4(c.operationId)) throw new KitchenError("invalid", "操作IDが正しくありません。", 400);
  if (c.expectedGeneration !== undefined
    && (!Number.isSafeInteger(c.expectedGeneration) || (c.expectedGeneration as number) < INITIAL_BOARD_GENERATION)) {
    throw new KitchenError("invalid", "盤面世代が正しくありません。", 400);
  }
  const generation = c.expectedGeneration as number | undefined;
  const withGeneration = <T extends object>(command: T): T & {expectedGeneration?:number} =>
    generation === undefined ? command : {...command, expectedGeneration:generation};
  if (c.type === "delete" && isPancakeId(c.id) && Number.isSafeInteger(c.expectedVersion) && (c.expectedVersion as number) > 0
    && Number.isSafeInteger(c.expectedGeneration) && (c.expectedGeneration as number) >= INITIAL_BOARD_GENERATION) {
    return {operationId:c.operationId, expectedGeneration:c.expectedGeneration as number, type:"delete", id:c.id, expectedVersion:c.expectedVersion as number};
  }
  if (c.type === "reset") return withGeneration({operationId:c.operationId, type:"reset"});
  const validNextOrdinal = Number.isSafeInteger(c.expectedNextPancakeOrdinal)
    && (c.expectedNextPancakeOrdinal as number) >= INITIAL_PANCAKE_ORDINAL
    && (c.expectedNextPancakeOrdinal as number) <= MAX_PANCAKE_IDS + 1;
  if (c.type === "doughStart" && c.expectedDoughBatchId === null && validNextOrdinal) {
    return withGeneration({operationId:c.operationId, type:c.type, expectedDoughBatchId:null, expectedNextPancakeOrdinal:c.expectedNextPancakeOrdinal as number});
  }
  if ((c.type === "doughReset" || c.type === "doughDiscardAndStart") && isUuidV4(c.expectedDoughBatchId) && validNextOrdinal) {
    return withGeneration({operationId:c.operationId, type:c.type, expectedDoughBatchId:c.expectedDoughBatchId, expectedNextPancakeOrdinal:c.expectedNextPancakeOrdinal as number});
  }
  if (c.type === "undo" && isUuidV4(c.expectedUndoOperationId)) {
    return withGeneration({operationId:c.operationId, type:"undo", expectedUndoOperationId:c.expectedUndoOperationId});
  }
  if (c.type === "create" && (c.plate === 1 || c.plate === 2) && typeof c.x === "number" && typeof c.y === "number" && Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1) {
    // Preserve an old client's UUID in the parsed command so its request hash
    // remains stable across upgrades; the board storage still assigns the ID.
    if (c.id !== undefined && !isUuidV4(c.id)) throw new KitchenError("invalid", "操作内容が正しくありません。", 400);
    const hasDoughBatch = Object.prototype.hasOwnProperty.call(c, "expectedDoughBatchId");
    const hasNextOrdinal = Object.prototype.hasOwnProperty.call(c, "expectedNextPancakeOrdinal");
    if (hasDoughBatch !== hasNextOrdinal
      || (hasDoughBatch && !(c.expectedDoughBatchId === null || isUuidV4(c.expectedDoughBatchId)))
      || (hasNextOrdinal && (!validNextOrdinal))) throw new KitchenError("invalid", "生地セットの操作前提が正しくありません。", 400);
    return withGeneration({
      operationId:c.operationId,
      type:c.type,
      id:c.id as string | undefined,
      plate:c.plate,
      x:c.x,
      y:c.y,
      ...(hasDoughBatch ? {expectedDoughBatchId:c.expectedDoughBatchId as string|null, expectedNextPancakeOrdinal:c.expectedNextPancakeOrdinal as number} : {}),
    });
  }
  if ((c.type === "start" || c.type === "remove" || c.type === "adjust" || c.type === "move") && isPancakeId(c.id) && Number.isSafeInteger(c.expectedVersion) && (c.expectedVersion as number) > 0) {
    const base = { operationId:c.operationId, id:c.id, expectedVersion:c.expectedVersion as number };
    if (c.type === "start" || c.type === "remove") return withGeneration({...base, type:c.type});
    if (c.type === "adjust" && (c.delta === -1 || c.delta === 1)) return withGeneration({...base, type:c.type, delta:c.delta});
    if (c.type === "move" && (c.plate === 1 || c.plate === 2) && typeof c.x === "number" && typeof c.y === "number" && Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1) {
      return withGeneration({...base, type:c.type, plate:c.plate, x:c.x, y:c.y});
    }
  }
  throw new KitchenError("invalid", "操作内容が正しくありません。", 400);
}
export function applySnapshotCommand(snapshot: Snapshot, command: Command, now: number): Snapshot {
  const doughTracked = Object.prototype.hasOwnProperty.call(snapshot, "doughBatch");
  const board = normalizeBoardData({
    items:snapshot.items,
    records:snapshot.records ?? [],
    completionItems:snapshot.completionItems ?? [],
    generation:snapshot.generation,
    nextPancakeOrdinal:snapshot.nextPancakeOrdinal,
    nextCreationOrdinal:snapshot.nextCreationOrdinal,
    undoHistory:snapshot.undoHistory ?? [],
    ...(doughTracked ? {doughBatch:snapshot.doughBatch} : {}),
  });
  const canonicalItems = board.items;
  const records = board.records;
  const completionItems = board.completionItems;
  const base:Snapshot = {...snapshot, ...board};
  const undoHistory = board.undoHistory;
  if (command.expectedGeneration === undefined) {
    if (board.generation !== INITIAL_BOARD_GENERATION) {
      throw new KitchenError("generation_conflict", "盤面が初期化されています。最新の状態を読み込んでから操作してください。");
    }
  } else if (command.expectedGeneration !== board.generation) {
    throw new KitchenError("generation_conflict", "盤面が初期化されています。最新の状態を読み込んでから操作してください。");
  }
  if (command.type === "reset") {
    if (board.generation >= Number.MAX_SAFE_INTEGER) throw new KitchenError("invalid_state", "盤面世代が上限に達したため、初期化できません。");
    return {
      ...base,
      generation:board.generation + 1,
      items:[],
      records:[],
      completionItems:[],
      nextPancakeOrdinal:INITIAL_PANCAKE_ORDINAL,
      nextCreationOrdinal:INITIAL_PANCAKE_ORDINAL,
      undoHistory:[],
      ...(doughTracked ? {doughBatch:null} : {}),
      serverNow:now,
    };
  }
  if (command.type === "doughStart" || command.type === "doughReset" || command.type === "doughDiscardAndStart") {
    if (!doughTracked) throw new KitchenError("unsupported", "この保存先では生地タイマーを操作できません。");
    const current = board.doughBatch ?? null;
    if (command.expectedDoughBatchId !== (current?.batchId ?? null)
      || command.expectedNextPancakeOrdinal !== board.nextPancakeOrdinal) {
      throw new KitchenError("dough_conflict", "生地セットまたは次のお好み焼きIDが更新されています。最新の表示を確認してください。");
    }
    if (command.type === "doughStart" && current !== null) {
      throw new KitchenError("dough_conflict", "生地セットはすでに開始されています。最新の表示を確認してください。");
    }
    if (command.type === "doughReset" && (!current || current.completedAt === null)) {
      throw new KitchenError("dough_incomplete", "24個の配置が完了した後に生地リセットを押してください。");
    }
    if (command.type === "doughDiscardAndStart" && (!current || current.completedAt !== null || now <= current.deadlineAt)) {
      throw new KitchenError("dough_not_expired", "期限超過後に残りを廃棄して次セットを開始してください。");
    }
    let firstPancakeOrdinal: number;
    if (command.type === "doughDiscardAndStart") {
      if (!current) throw new KitchenError("dough_conflict", "期限切れの生地セットを確認できません。最新の表示を確認してください。");
      firstPancakeOrdinal = current.firstPancakeOrdinal + DOUGH_BATCH_SIZE;
    } else {
      firstPancakeOrdinal = nextDoughBatchFirstOrdinal(board.nextPancakeOrdinal);
    }
    if (firstPancakeOrdinal + DOUGH_BATCH_SIZE - 1 > MAX_PANCAKE_IDS) {
      throw new KitchenError("id_capacity", "お好み焼きIDの上限に達しているため、次の24個セットを開始できません。");
    }
    if (board.generation >= Number.MAX_SAFE_INTEGER) throw new KitchenError("invalid_state", "盤面世代が上限に達したため、生地セットを開始できません。");
    if (!Number.isSafeInteger(now) || now < 0 || now + DOUGH_BATCH_DURATION > Number.MAX_SAFE_INTEGER) {
      throw new KitchenError("invalid_state", "端末時刻を確認できないため、生地タイマーを開始できません。");
    }
    const nextBatch: DoughBatchState = {
      batchId:command.operationId,
      firstPancakeOrdinal,
      startedAt:now,
      deadlineAt:now + DOUGH_BATCH_DURATION,
      placedEntityKeys:[],
      completedAt:null,
    };
    return normalizeChangedBoard({
      ...base,
      generation:board.generation + 1,
      nextPancakeOrdinal:firstPancakeOrdinal,
      doughBatch:nextBatch,
      undoHistory:[],
      serverNow:now,
    });
  }
  if (command.type === "delete") {
    if (!doughTracked) throw new KitchenError("unsupported", "盤外削除はPages版の保存画面でのみ使えます。");
    const item = canonicalItems.find(candidate => candidate.id === command.id);
    if (!item) throw new KitchenError("removed", "このお好み焼きは取り出されています。");
    if (item.version !== command.expectedVersion) throw new KitchenError("conflict", "別の端末で変更されました。最新の表示でもう一度操作してください。");
    if (board.generation >= Number.MAX_SAFE_INTEGER) throw new KitchenError("invalid_state", "盤面世代が上限に達したため、削除できません。");
    const discarded = item.startedAt === null ? null : collectDiscardRecord(item, now);
    const undoEntry:UndoEntry = {
      operationId:command.operationId,
      type:"delete",
      id:item.id,
      entityKey:item.entityKey,
      creationOrdinal:item.creationOrdinal,
      pancake:item,
      discardRecordEntityKey:discarded?.entityKey ?? null,
    };
    return normalizeChangedBoard({
      ...base,
      generation:board.generation + 1,
      items:canonicalItems.filter(candidate => candidate.entityKey !== item.entityKey),
      records:discarded ? [...records, discarded] : records,
      undoHistory:pushUndoEntry(undoHistory, undoEntry),
      serverNow:now,
    });
  }
  if (command.type === "undo") {
    const latest = undoHistory[undoHistory.length - 1];
    if (!latest || latest.operationId !== command.expectedUndoOperationId) {
      throw new KitchenError("undo_conflict", "取り消す対象が更新されています。最新の状態を確認してください。");
    }
    const remainingHistory = undoHistory.slice(0, -1);
    if (latest.type === "create") {
      const target = canonicalItems.find(item => item.entityKey === latest.entityKey);
      if (!target || target.creationOrdinal !== latest.creationOrdinal
        || records.some(record => record.entityKey === latest.entityKey)
        || completionItems.some(item => item.entityKey === latest.entityKey)
        || remainingHistory.some(entry => entry.entityKey === latest.entityKey
          || (entry.type === "delete" && entry.pancake.entityKey === latest.entityKey)
          || (entry.type === "move" && entry.overflowPlateRestore?.positions.some(position => position.entityKey === latest.entityKey)))) {
        throw new KitchenError("undo_conflict", "配置した楕円の状態が更新されています。最新の状態を確認してください。");
      }
      if (board.generation >= Number.MAX_SAFE_INTEGER) {
        throw new KitchenError("invalid_state", "盤面世代が上限に達したため、配置を取り消せません。");
      }
      const remainingItems = canonicalItems.filter(item => item.entityKey !== latest.entityKey);
      const remainingRecords = records.filter(record => record.entityKey !== latest.entityKey);
      const remainingCompletionItems = completionItems.filter(item => item.entityKey !== latest.entityKey);
      const canReuseCreationOrdinal = target.creationOrdinal === board.nextCreationOrdinal - 1;
      const canReusePlacementOrdinal = board.nextPancakeOrdinal > INITIAL_PANCAKE_ORDINAL;
      if (!canReuseCreationOrdinal || !canReusePlacementOrdinal) {
        throw new KitchenError("undo_conflict", "この配置の作成順を安全に戻せないため、操作を取り消せません。");
      }
      let doughBatch = board.doughBatch;
      if (doughTracked && doughBatch !== null && doughBatch !== undefined) {
        const currentBatch = doughBatch;
        if (currentBatch.placedEntityKeys.at(-1) !== latest.entityKey) {
          throw new KitchenError("undo_conflict", "この配置IDを安全に再利用できないため、操作を取り消せません。生地残数は変更していません。");
        }
        doughBatch = {
          ...currentBatch,
          placedEntityKeys:currentBatch.placedEntityKeys.slice(0, -1),
          completedAt:null,
        };
      } else if (doughTracked) {
        throw new KitchenError("undo_conflict", "この配置の生地セットを確認できないため、操作を取り消せません。");
      }
      return normalizeChangedBoard({
        ...base,
        generation:board.generation + 1,
        items:remainingItems,
        nextPancakeOrdinal:board.nextPancakeOrdinal - 1,
        nextCreationOrdinal:board.nextCreationOrdinal - 1,
        undoHistory:remainingHistory,
        ...(doughTracked ? {doughBatch} : {}),
      });
    }
    if (latest.type === "move") {
      const item = canonicalItems.find(candidate => candidate.entityKey === latest.entityKey);
      if (latest.overflowPlateRestore) {
        const restore = latest.overflowPlateRestore;
        const restoreKeys = new Set(restore.positions.map(position => position.entityKey));
        const currentByKey = new Map(canonicalItems.map(candidate => [candidate.entityKey, candidate]));
        const currentItemsToCheck = restore.legacyPlate === undefined
          ? canonicalItems
          : canonicalItems.filter(candidate => candidate.plate === restore.legacyPlate);
        if (!item || !restoreKeys.has(item.entityKey)
          || currentItemsToCheck.some(candidate => !restoreKeys.has(candidate.entityKey))
          || restore.positions.some(position => !currentByKey.has(position.entityKey))) {
          throw new KitchenError("undo_conflict", "移動前の過密状態へ戻せません。最新の状態を確認してください。");
        }
        if (restore.positions.some(position => (currentByKey.get(position.entityKey)?.version ?? Number.MAX_SAFE_INTEGER) >= Number.MAX_SAFE_INTEGER)) {
          throw new KitchenError("invalid_state", "楕円の更新回数が上限に達しました。");
        }
        const restoreByKey = new Map(restore.positions.map(position => [position.entityKey, position]));
        const restoredItems = canonicalItems.map(candidate => {
          const position = restoreByKey.get(candidate.entityKey);
          if (!position) return candidate;
          return {
            ...candidate,
            plate:position.plate,
            x:position.x,
            y:position.y,
            ...(candidate.entityKey === latest.entityKey ? {movedToUpperAt:null} : {}),
            version:candidate.version + 1,
          };
        });
        return normalizeChangedBoard({...base, items:restoredItems, undoHistory:remainingHistory});
      }
      const overCapacity = isGridOverCapacity(canonicalItems);
      const targetCell = overCapacity ? null : nearestGridCell(latest.from.x, latest.from.y);
      const targetOccupied = targetCell
        ? isGridCellOccupied(canonicalItems, latest.from.plate, targetCell.index, item?.id)
        : canonicalItems.some(candidate => candidate.id !== item?.id && candidate.plate === latest.from.plate && overlapsLegacy(candidate, latest.from));
      if (!item || targetOccupied) {
        throw new KitchenError("undo_conflict", "移動前のマスに戻せません。最新の状態を確認してください。");
      }
      if (item.version >= Number.MAX_SAFE_INTEGER) throw new KitchenError("invalid_state", "楕円の更新回数が上限に達しました。");
      const restored = {...item, ...latest.from, ...(targetCell ? {x:targetCell.x, y:targetCell.y} : {}), movedToUpperAt:null, version:item.version + 1};
      return normalizeChangedBoard({...base, items:canonicalItems.map(candidate => candidate.id === item.id ? restored : candidate), undoHistory:remainingHistory});
    }
    if (canonicalItems.some(item => item.entityKey === latest.entityKey) || completionItems.some(item => item.entityKey === latest.entityKey)) {
      throw new KitchenError("undo_conflict", "削除した楕円のIDが既に使われています。最新の状態を確認してください。");
    }
    if (board.generation >= Number.MAX_SAFE_INTEGER) throw new KitchenError("invalid_state", "盤面世代が上限に達したため、削除を取り消せません。");
    const overCapacity = isGridOverCapacity(canonicalItems);
    const restoredCell = overCapacity ? null : nearestGridCell(latest.pancake.x, latest.pancake.y);
    if (restoredCell
      ? isGridCellOccupied(canonicalItems, latest.pancake.plate, restoredCell.index)
      : canonicalItems.some(item => item.plate === latest.pancake.plate && overlapsLegacy(item, latest.pancake))) {
      throw new KitchenError("undo_conflict", "削除前の場所に別の楕円があるため戻せません。最新の状態を確認してください。");
    }
    if (latest.discardRecordEntityKey !== null && !records.some(record => record.entityKey === latest.discardRecordEntityKey
      && record.unavailableReason === PLATE_DISCARD_REASON && record.serveTimerStartedAt === null)) {
      throw new KitchenError("undo_conflict", "盤外破棄記録が更新されています。最新の状態を確認してください。");
    }
    if (latest.discardRecordEntityKey === null && records.some(record => record.entityKey === latest.entityKey)) {
      throw new KitchenError("undo_conflict", "削除した楕円の実行記録が更新されています。最新の状態を確認してください。");
    }
    if (latest.pancake.version >= Number.MAX_SAFE_INTEGER) throw new KitchenError("invalid_state", "楕円の更新回数が上限に達しました。");
    const restored = {...latest.pancake, ...(restoredCell ? {x:restoredCell.x, y:restoredCell.y} : {}), version:latest.pancake.version + 1};
    return normalizeChangedBoard({
      ...base,
      generation:board.generation + 1,
      items:[...canonicalItems, restored],
      records:latest.discardRecordEntityKey === null ? records : records.filter(record => record.entityKey !== latest.discardRecordEntityKey),
      undoHistory:remainingHistory,
    });
  }
  if (command.type === "create") {
    let nextDoughBatch: DoughBatchState | null | undefined;
    if (doughTracked) {
      const currentBatch = board.doughBatch ?? null;
      if (!Object.prototype.hasOwnProperty.call(command, "expectedDoughBatchId")
        || command.expectedDoughBatchId !== (currentBatch?.batchId ?? null)
        || command.expectedNextPancakeOrdinal !== board.nextPancakeOrdinal) {
        throw new KitchenError("dough_conflict", "生地セットまたは次のお好み焼きIDが更新されています。画面を再読み込みしてください。");
      }
      if (!currentBatch) throw new KitchenError("dough_not_started", "新しい楕円を置く前に「生地を取り出す」を押してください。");
      if (currentBatch.completedAt !== null || currentBatch.placedEntityKeys.length >= DOUGH_BATCH_SIZE) {
        throw new KitchenError("dough_complete", "この生地セットは24個の配置が完了しています。「生地リセット」で次のセットを開始してください。");
      }
      if (now > currentBatch.deadlineAt) throw new KitchenError("dough_expired", "生地の20分期限を過ぎています。配置を停止し、残りを廃棄してください。");
      if (currentBatch.firstPancakeOrdinal + currentBatch.placedEntityKeys.length !== board.nextPancakeOrdinal) {
        throw new KitchenError("dough_conflict", "生地セットの配置IDを確認できません。最新の表示を確認してください。");
      }
      nextDoughBatch = {
        ...currentBatch,
        placedEntityKeys:[...currentBatch.placedEntityKeys, command.operationId],
        completedAt:currentBatch.placedEntityKeys.length + 1 === DOUGH_BATCH_SIZE ? now : null,
      };
    }
    const position = nearestGridCell(command.x, command.y);
    if (position.row !== GRID_ROWS - 1) {
      throw new KitchenError("upper_row_create_forbidden", "新しい楕円は下段に配置してください。上段は下段からの移動専用です。");
    }
    requireGridCapacity(canonicalItems);
    if (isGridCellOccupied(canonicalItems, command.plate, position.index)) throw new KitchenError("cell_occupied", "このマスにはすでに楕円があります。空いているマスをタップしてください。");
    const currentEntityCount = new Set([...canonicalItems, ...records].map(entity => entity.entityKey)).size;
    if (currentEntityCount >= MAX_PANCAKE_IDS) {
      throw new KitchenError("id_capacity", "保存中のお好み焼きが表示上限（192個）に達しています。記録を確認してください。");
    }
    if (board.nextPancakeOrdinal > MAX_PANCAKE_IDS || board.nextCreationOrdinal >= Number.MAX_SAFE_INTEGER) {
      throw new KitchenError("id_capacity", "お好み焼きの配置上限（192個）に達しました。新しい楕円を配置できません。");
    }
    const entityKey = command.operationId;
    const creationOrdinal = board.nextCreationOrdinal;
    const id = pancakeIdForOrdinal(currentEntityCount + 1);
    const entry:UndoEntry = {operationId:command.operationId, type:"create", id, entityKey, creationOrdinal};
    const created:Pancake = {id, entityKey, creationOrdinal, plate:command.plate, x:position.x, y:position.y, griddlePlacedAt:now, movedToUpperAt:null, duration:TIMER_DURATION, temperature:DEFAULT_TEMPERATURE, startedAt:null, segments:[], version:1};
    return normalizeChangedBoard({...base, items:[...canonicalItems, created], records, completionItems, nextPancakeOrdinal:board.nextPancakeOrdinal + 1, nextCreationOrdinal:board.nextCreationOrdinal + 1, undoHistory:pushUndoEntry(undoHistory, entry), ...(doughTracked ? {doughBatch:nextDoughBatch} : {})});
  }
  if (command.type === "remove") {
    const completionItem = completionItems.find(item => item.id === command.id);
    if (completionItem) {
      if (completionItem.version !== command.expectedVersion) throw new KitchenError("conflict", "完成ボックスの状態が更新されています。最新の表示でもう一度操作してください。");
      const record = records.find(item => item.entityKey === completionItem.entityKey);
      if (!record || record.serveDeadlineAt === null || record.serveTimerStartedAt === null) {
        throw new KitchenError("invalid_state", "完成ボックスの期限を確認できません。");
      }
      const deadline = record.serveDeadlineAt;
      const serveAt = Math.max(now, record.serveTimerStartedAt);
      const updated = serveAt < deadline
        ? {...record, servedAt:serveAt}
        : {...record, unavailableAt:deadline, unavailableReason:COMPLETION_EXPIRED_REASON};
      return {
        ...base,
        items:canonicalItems,
        records:records.map(item => item.entityKey === updated.entityKey ? updated : item),
        completionItems:completionItems.filter(item => item.entityKey !== completionItem.entityKey),
        undoHistory:[],
      };
    }
  }
  const item = canonicalItems.find(i => i.id === command.id);
  if (!item) throw new KitchenError("removed", "このお好み焼きは取り出されています。");
  if (command.type === "start" && item.startedAt !== null) return {...base, items:canonicalItems, records, completionItems};
  if (item.version !== command.expectedVersion) throw new KitchenError("conflict", "別の端末で変更されました。最新の表示でもう一度操作してください。");
  const current = timer(item, now);
  if (command.type === "remove") {
    if (command.type === "remove" && current.state !== "done") throw new KitchenError("not_finished", "焼き上がった赤いお好み焼きをタップしてください。");
    const completed = current.state === "done" ? collectRecord(item, now) : null;
    return normalizeChangedBoard({
      ...base,
      items:canonicalItems.filter(i => i.entityKey !== item.entityKey),
      records:completed ? [...records, completed] : records,
      completionItems:completed?.serveTimerStartedAt !== null && completed ? [...completionItems, {id:item.id, entityKey:item.entityKey, creationOrdinal:item.creationOrdinal, version:1}] : completionItems,
      undoHistory:[],
    });
  }
  let next: Pancake;
  if (command.type === "start") next = {...item, startedAt:now, segments:[{temperature:item.temperature, startedAt:now, endedAt:null}], version:item.version + 1};
  else if (command.type === "move") {
    const position = nearestGridCell(command.x, command.y);
    const blockReason = gridMoveBlockReason(canonicalItems, item.id, command.plate, position.index);
    if (blockReason === "missing") throw new KitchenError("removed", "このお好み焼きは取り出されています。");
    if (blockReason === "source_not_bottom") throw new KitchenError("move_restricted", "上段のお好み焼きは移動できません。");
    if (blockReason === "different_plate") throw new KitchenError("move_restricted", "別の鉄板へは移動できません。同じ鉄板で操作してください。");
    if (blockReason === "wrong_row") throw new KitchenError("move_restricted", "下段から真上の上段マスへのみ移動できます。");
    if (blockReason === "different_column") throw new KitchenError("move_restricted", "同じ列の真上にあるマスへ移動してください。");
    if (blockReason === "over_capacity") {
      throw new KitchenError("grid_over_capacity", "既存の過密状態を保持中のため、この鉄板からは移動できません。焼き上がった楕円を完成ボックスへ移してください。");
    }
    if (blockReason === "occupied") {
      throw new KitchenError("cell_occupied", "移動先の上段マスは使用中のため移動できません。");
    }
    next = {...item, plate:command.plate, x:position.x, y:position.y, movedToUpperAt:now, version:item.version + 1};
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
  const moveUndoEntry: UndoEntry | null = command.type === "move"
    ? (() => {
      const preserveOverflowPositions = isGridOverCapacity(canonicalItems);
      return {
        operationId:command.operationId,
        type:"move",
        id:item.id,
        entityKey:item.entityKey,
        creationOrdinal:item.creationOrdinal,
        from:{plate:item.plate, x:item.x, y:item.y},
        ...(preserveOverflowPositions
          ? {overflowPlateRestore:{
            positions:canonicalItems.map(candidate => ({id:candidate.id, entityKey:candidate.entityKey, creationOrdinal:candidate.creationOrdinal, plate:candidate.plate, x:candidate.x, y:candidate.y})),
          }}
          : {}),
      };
    })()
    : null;
  return normalizeChangedBoard({
    ...base,
    items:canonicalItems.map(i => i.id === item.id ? next : i),
    records,
    completionItems,
    undoHistory:moveUndoEntry
      ? pushUndoEntry(undoHistory, moveUndoEntry)
      : [],
  });
}

function pushUndoEntry(history: readonly UndoEntry[], entry: UndoEntry): UndoEntry[] {
  return [...history, entry].slice(-MAX_UNDO_HISTORY);
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

function collectRecord(item: Pancake, now: number): ExecutionRecord {
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
    entityKey:item.entityKey,
    creationOrdinal:item.creationOrdinal,
    griddlePlacedAt:item.griddlePlacedAt,
    movedToUpperAt:item.movedToUpperAt,
    startedAt:item.startedAt,
    collectedAt,
    segments,
    cookCompletedAt,
    serveTimerStartedAt:collectedAt,
    serveDeadlineAt:collectedAt + COMPLETION_BOX_DURATION * 1000,
    servedAt:null,
    unavailableAt:null,
    unavailableReason:null,
  };
}

function collectDiscardRecord(item:Pancake, now:number):ExecutionRecord {
  const completed = collectRecord(item, now);
  return {
    ...completed,
    serveTimerStartedAt:null,
    serveDeadlineAt:null,
    unavailableAt:completed.collectedAt,
    unavailableReason:PLATE_DISCARD_REASON,
  };
}

// Kept as an items-only adapter for existing model consumers. The storage
// paths use applySnapshotCommand so completed records commit atomically.
export function applyCommand(items: Pancake[], command: Command, now: number): Pancake[] {
  if (command.type === "undo") throw new KitchenError("invalid_state", "操作の取り消しにはボード状態が必要です。");
  if (command.type === "reset") throw new KitchenError("invalid_state", "盤面の初期化にはボード状態が必要です。");
  if (command.type === "doughStart" || command.type === "doughReset" || command.type === "doughDiscardAndStart") {
    throw new KitchenError("invalid_state", "生地セットの操作にはボード状態が必要です。");
  }
  const greatestOrdinal = items.reduce((greatest, item) => Math.max(greatest, pancakeOrdinalForId(item.id) ?? 0), 0);
  const board = normalizeBoardData({items, records:[], completionItems:[], nextPancakeOrdinal:greatestOrdinal + 1});
  const migratedIdByOriginal = new Map(items.map((item, index) => [item.id, board.items[index].id]));
  const compatibleCommand = command.type === "create"
    ? command
    : {...command, id:migratedIdByOriginal.get(command.id) ?? command.id};
  const originalIdByMigrated = new Map(board.items.map((item, index) => [item.id, items[index].id]));
  const updatedItems = applySnapshotCommand({revision:0, ...board, serverNow:now}, compatibleCommand, now).items;
  return updatedItems.map(item => ({...item, id:originalIdByMigrated.get(item.id) ?? item.id}));
}
