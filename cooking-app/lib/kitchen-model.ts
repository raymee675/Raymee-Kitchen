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
type OverflowRestorePosition = { id:string; plate:1|2; x:number; y:number };
type OverflowPlateRestore = { positions:Array<OverflowRestorePosition>; legacyPlate?:1|2 };
export type UndoEntry =
  | { operationId: string; type: "create"; id: string }
  | { operationId: string; type: "move"; id: string; from: Pick<Pancake, "plate" | "x" | "y">; overflowPlateRestore?: OverflowPlateRestore }
  | { operationId: string; type: "delete"; id: string; pancake: Pancake; discardRecordId: string | null };
export const MAX_UNDO_HISTORY = 50;
export interface Snapshot { revision: number; generation: number; items: Pancake[]; records: ExecutionRecord[]; completionItems: CompletionItem[]; nextPancakeOrdinal: number; undoHistory: UndoEntry[]; serverNow: number; serverReceivedAt?: number }
export function clockSample(serverNow:number, serverReceivedAt:number, elapsed:number) {
  const networkRtt = Math.max(0, elapsed - Math.max(0, serverNow - serverReceivedAt));
  return {networkRtt, estimatedNow:serverNow + networkRtt / 2};
}
export type Command =
  | { operationId: string; expectedGeneration?: number; type: "create"; id?: string; plate: 1 | 2; x: number; y: number }
  | { operationId: string; expectedGeneration?: number; type: "start" | "remove"; id: string; expectedVersion: number }
  | { operationId: string; expectedGeneration?: number; type: "move"; id: string; expectedVersion: number; plate: 1 | 2; x: number; y: number }
  | { operationId: string; expectedGeneration?: number; type: "adjust"; id: string; expectedVersion: number; delta: -1 | 1 }
  | { operationId: string; expectedGeneration?: number; type: "undo"; expectedUndoOperationId: string }
  | { operationId: string; expectedGeneration?: number; type: "reset" };

export const INITIAL_BOARD_GENERATION = 0;

const UUID_V4_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQUENTIAL_ID_RX = /^([1-8])-(?:([1-9])|(1[0-9])|(2[0-4]))$/;
export const MAX_PANCAKE_IDS = 8 * 24;
export const INITIAL_PANCAKE_ORDINAL = 1;

export function isPancakeId(value: unknown): value is string {
  return typeof value === "string" && (UUID_V4_RX.test(value) || SEQUENTIAL_ID_RX.test(value));
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RX.test(value);
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
    if (!isPancakeId(candidate.id) || !Number.isFinite(candidate.startedAt) || !Number.isFinite(candidate.collectedAt)
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

export interface NormalizedBoardData {
  generation: number;
  items: Pancake[];
  records: ExecutionRecord[];
  completionItems: CompletionItem[];
  nextPancakeOrdinal: number;
  undoHistory: UndoEntry[];
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
    if (entry.type === "create") return {operationId:entry.operationId, type:entry.type, id:entry.id};
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
          return {id:savedPosition.id, plate:plate as 1|2, x:savedPosition.x as number, y:savedPosition.y as number};
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
      if (pancake.id !== entry.id || !(entry.discardRecordId === null || entry.discardRecordId === pancake.id)) {
        throw new Error("保存データの削除取り消し履歴が正しくありません。");
      }
      if (canonicalizePositions) {
        const cell = nearestGridCell(pancake.x, pancake.y);
        pancake = {...pancake, x:cell.x, y:cell.y};
      }
      if (entry.discardRecordId !== null && !records.some(record => record.id === entry.discardRecordId
        && record.unavailableReason === PLATE_DISCARD_REASON && record.serveTimerStartedAt === null)) {
        throw new Error("保存データの盤外破棄記録を取り消し履歴と照合できません。");
      }
      return {operationId:entry.operationId, type:entry.type, id:entry.id, pancake, discardRecordId:entry.discardRecordId as string | null};
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
  undoHistory?: unknown;
}): NormalizedBoardData {
  const generation = input.generation === undefined ? INITIAL_BOARD_GENERATION : input.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < INITIAL_BOARD_GENERATION) {
    throw new Error("保存データの盤面世代が正しくありません。");
  }
  const records = normalizeExecutionRecords(input.records);
  const completionBeforeMigration = normalizeCompletionItems(input.completionItems, records);
  let items = normalizePancakes(input.items);
  const activeIds = new Set<string>();
  for (const item of items) {
    if (activeIds.has(item.id)) throw new Error("保存データに重複したお好み焼きIDがあります。");
    activeIds.add(item.id);
  }
  if (items.some(item => records.some(record => record.id === item.id))) {
    throw new Error("鉄板上のお好み焼きと実行記録のIDが重複しています。");
  }
  if (completionBeforeMigration.some(item => activeIds.has(item.id))) {
    throw new Error("完成ボックスと鉄板上のお好み焼きのIDが重複しています。");
  }

  const allSavedIds = [...items.map(item => item.id), ...records.map(record => record.id), ...completionBeforeMigration.map(item => item.id)];
  const greatestSavedOrdinal = allSavedIds.reduce((greatest, id) => Math.max(greatest, pancakeOrdinalForId(id) ?? 0), 0);
  let nextPancakeOrdinal: number;
  if (input.nextPancakeOrdinal === undefined) {
    if (greatestSavedOrdinal > 0) {
      throw new Error("M-N形式のお好み焼きIDがある保存データには採番カウンターが必要です。");
    }
    nextPancakeOrdinal = Math.max(INITIAL_PANCAKE_ORDINAL, greatestSavedOrdinal + 1);
  } else {
    if (!Number.isSafeInteger(input.nextPancakeOrdinal)
      || (input.nextPancakeOrdinal as number) < INITIAL_PANCAKE_ORDINAL
      || (input.nextPancakeOrdinal as number) > MAX_PANCAKE_IDS + 1
      || (input.nextPancakeOrdinal as number) <= greatestSavedOrdinal) {
      throw new Error("保存データのお好み焼き採番カウンターが正しくありません。");
    }
    nextPancakeOrdinal = input.nextPancakeOrdinal as number;
  }

  const remappedIds = new Map<string, string>();
  const allocateLegacyId = (id: string) => {
    if (!isUuidV4(id)) return id;
    const existing = remappedIds.get(id);
    if (existing) return existing;
    if (nextPancakeOrdinal > MAX_PANCAKE_IDS) {
      throw new KitchenError("id_capacity", "旧データに現在のID形式へ移行できない数のお好み焼きがあります。保存データは変更していません。");
    }
    const migrated = pancakeIdForOrdinal(nextPancakeOrdinal++);
    remappedIds.set(id, migrated);
    return migrated;
  };

  const overCapacity = !hasGridCapacity(items);
  if (!overCapacity) items = canonicalizeItemPositions(items);
  items = items.map(item => ({...item, id:allocateLegacyId(item.id)}));
  const completionItems = completionBeforeMigration.map(item => ({...item, id:allocateLegacyId(item.id)}));
  const migratedRecords = records.map(record => {
    const id = remappedIds.get(record.id);
    return id ? {...record, id} : record;
  });

  const migratedIds = new Set<string>();
  for (const item of items) {
    if (migratedIds.has(item.id)) throw new Error("移行後のお好み焼きIDが重複しています。");
    migratedIds.add(item.id);
  }
  if (items.some(item => migratedRecords.some(record => record.id === item.id))) {
    throw new Error("移行後の鉄板上お好み焼きと実行記録のIDが重複しています。");
  }
  const normalizedRecords = normalizeExecutionRecords(migratedRecords);
  const undoHistory = normalizeUndoHistory(input.undoHistory, normalizedRecords, !overCapacity);
  return {
    generation:generation as number,
    items,
    records:normalizedRecords,
    completionItems:normalizeCompletionItems(completionItems, normalizedRecords),
    nextPancakeOrdinal,
    undoHistory,
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
    undoHistory:snapshot.undoHistory,
  });
  return {...snapshot, ...board};
}
function requireGridCapacity(items: readonly Pancake[]): void {
  if (isGridOverCapacity(items)) {
    throw new KitchenError("grid_over_capacity", "各鉄板が6枚以下になるまで、楕円の配置・移動はできません。焼き上がった楕円を完成ボックスへ移してください。");
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
  if (c.type === "delete") throw new KitchenError("delete_removed", "盤外削除は廃止されました。画面を再読み込みしてください。");
  if (c.type === "reset") return withGeneration({operationId:c.operationId, type:"reset"});
  if (c.type === "undo" && isUuidV4(c.expectedUndoOperationId)) {
    return withGeneration({operationId:c.operationId, type:"undo", expectedUndoOperationId:c.expectedUndoOperationId});
  }
  if (c.type === "create" && (c.plate === 1 || c.plate === 2) && typeof c.x === "number" && typeof c.y === "number" && Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1) {
    // Preserve an old client's UUID in the parsed command so its request hash
    // remains stable across upgrades; the board storage still assigns the ID.
    if (c.id !== undefined && !isUuidV4(c.id)) throw new KitchenError("invalid", "操作内容が正しくありません。", 400);
    return withGeneration({ operationId:c.operationId, type:c.type, id:c.id as string | undefined, plate:c.plate, x:c.x, y:c.y });
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
  const board = normalizeBoardData({
    items:snapshot.items,
    records:snapshot.records ?? [],
    completionItems:snapshot.completionItems ?? [],
    generation:snapshot.generation,
    nextPancakeOrdinal:snapshot.nextPancakeOrdinal,
    undoHistory:snapshot.undoHistory ?? [],
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
      undoHistory:[],
      serverNow:now,
    };
  }
  if (command.type === "undo") {
    const latest = undoHistory[undoHistory.length - 1];
    if (!latest || latest.operationId !== command.expectedUndoOperationId) {
      throw new KitchenError("undo_conflict", "取り消す対象が更新されています。最新の状態を確認してください。");
    }
    const remainingHistory = undoHistory.slice(0, -1);
    if (latest.type === "create") {
      if (!canonicalItems.some(item => item.id === latest.id)
        || records.some(record => record.id === latest.id)
        || completionItems.some(item => item.id === latest.id)) {
        throw new KitchenError("undo_conflict", "配置した楕円の状態が更新されています。最新の状態を確認してください。");
      }
      if (board.generation >= Number.MAX_SAFE_INTEGER) {
        throw new KitchenError("invalid_state", "盤面世代が上限に達したため、配置を取り消せません。");
      }
      const remainingItems = canonicalItems.filter(item => item.id !== latest.id);
      const remainingRecords = records.filter(record => record.id !== latest.id);
      const remainingCompletionItems = completionItems.filter(item => item.id !== latest.id);
      const ordinal = pancakeOrdinalForId(latest.id);
      const canReuseId = ordinal !== null
        && ordinal === board.nextPancakeOrdinal - 1
        && !remainingItems.some(item => item.id === latest.id)
        && !remainingRecords.some(record => record.id === latest.id)
        && !remainingCompletionItems.some(item => item.id === latest.id);
      return normalizeChangedBoard({
        ...base,
        generation:board.generation + 1,
        items:remainingItems,
        nextPancakeOrdinal:canReuseId ? ordinal : board.nextPancakeOrdinal,
        undoHistory:remainingHistory,
      });
    }
    if (latest.type === "move") {
      const item = canonicalItems.find(candidate => candidate.id === latest.id);
      if (latest.overflowPlateRestore) {
        const restore = latest.overflowPlateRestore;
        const restoreIds = new Set(restore.positions.map(position => position.id));
        const currentById = new Map(canonicalItems.map(candidate => [candidate.id, candidate]));
        const currentItemsToCheck = restore.legacyPlate === undefined
          ? canonicalItems
          : canonicalItems.filter(candidate => candidate.plate === restore.legacyPlate);
        if (!item || !restoreIds.has(item.id)
          || currentItemsToCheck.some(candidate => !restoreIds.has(candidate.id))
          || restore.positions.some(position => !currentById.has(position.id))) {
          throw new KitchenError("undo_conflict", "移動前の過密状態へ戻せません。最新の状態を確認してください。");
        }
        if (restore.positions.some(position => (currentById.get(position.id)?.version ?? Number.MAX_SAFE_INTEGER) >= Number.MAX_SAFE_INTEGER)) {
          throw new KitchenError("invalid_state", "楕円の更新回数が上限に達しました。");
        }
        const restoreById = new Map(restore.positions.map(position => [position.id, position]));
        const restoredItems = canonicalItems.map(candidate => {
          const position = restoreById.get(candidate.id);
          return position
            ? {...candidate, plate:position.plate, x:position.x, y:position.y, version:candidate.version + 1}
            : candidate;
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
      const restored = {...item, ...latest.from, ...(targetCell ? {x:targetCell.x, y:targetCell.y} : {}), version:item.version + 1};
      return normalizeChangedBoard({...base, items:canonicalItems.map(candidate => candidate.id === item.id ? restored : candidate), undoHistory:remainingHistory});
    }
    if (canonicalItems.some(item => item.id === latest.id) || completionItems.some(item => item.id === latest.id)) {
      throw new KitchenError("undo_conflict", "削除した楕円のIDが既に使われています。最新の状態を確認してください。");
    }
    const overCapacity = isGridOverCapacity(canonicalItems);
    const restoredCell = overCapacity ? null : nearestGridCell(latest.pancake.x, latest.pancake.y);
    if (restoredCell
      ? isGridCellOccupied(canonicalItems, latest.pancake.plate, restoredCell.index)
      : canonicalItems.some(item => item.plate === latest.pancake.plate && overlapsLegacy(item, latest.pancake))) {
      throw new KitchenError("undo_conflict", "削除前の場所に別の楕円があるため戻せません。最新の状態を確認してください。");
    }
    if (latest.discardRecordId !== null && !records.some(record => record.id === latest.discardRecordId)) {
      throw new KitchenError("undo_conflict", "盤外破棄記録が更新されています。最新の状態を確認してください。");
    }
    if (latest.pancake.version >= Number.MAX_SAFE_INTEGER) throw new KitchenError("invalid_state", "楕円の更新回数が上限に達しました。");
    const restored = {...latest.pancake, ...(restoredCell ? {x:restoredCell.x, y:restoredCell.y} : {}), version:latest.pancake.version + 1};
    return normalizeChangedBoard({
      ...base,
      items:[...canonicalItems, restored],
      records:latest.discardRecordId === null ? records : records.filter(record => record.id !== latest.discardRecordId),
      undoHistory:remainingHistory,
    });
  }
  if (command.type === "create") {
    requireGridCapacity(canonicalItems);
    const position = nearestGridCell(command.x, command.y);
    if (isGridCellOccupied(canonicalItems, command.plate, position.index)) throw new KitchenError("cell_occupied", "このマスにはすでに楕円があります。空いているマスをタップしてください。");
    const id = pancakeIdForOrdinal(board.nextPancakeOrdinal);
    const entry:UndoEntry = {operationId:command.operationId, type:"create", id};
    return {...base, items:[...canonicalItems, {id, plate:command.plate, x:position.x, y:position.y, duration:TIMER_DURATION, temperature:DEFAULT_TEMPERATURE, startedAt:null, segments:[], version:1}], records, completionItems, nextPancakeOrdinal:board.nextPancakeOrdinal + 1, undoHistory:pushUndoEntry(undoHistory, entry)};
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
        ...base,
        items:canonicalItems,
        records:records.map(item => item.id === updated.id ? updated : item),
        completionItems:completionItems.filter(item => item.id !== completionItem.id),
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
      items:canonicalItems.filter(i => i.id !== item.id),
      records:completed ? [...records, completed] : records,
      completionItems:completed?.serveTimerStartedAt !== null && completed ? [...completionItems, {id:item.id, version:1}] : completionItems,
      undoHistory:[],
    });
  }
  let next: Pancake;
  if (command.type === "start") next = {...item, startedAt:now, segments:[{temperature:item.temperature, startedAt:now, endedAt:null}], version:item.version + 1};
  else if (command.type === "move") {
    const position = nearestGridCell(command.x, command.y);
    const blockReason = gridDropBlockReason(canonicalItems, command.plate, position.index, item.id);
    if (blockReason === "over_capacity") {
      throw new KitchenError("grid_over_capacity", "6枚を超えている鉄板には移動できません。空きのある別の鉄板へ移動してください。");
    }
    if (blockReason === "occupied") {
      throw new KitchenError("cell_occupied", "このマスは使用中のため移動できません。");
    }
    next = {...item, plate:command.plate, x:position.x, y:position.y, version:item.version + 1};
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
        from:{plate:item.plate, x:item.x, y:item.y},
        ...(preserveOverflowPositions
          ? {overflowPlateRestore:{
            positions:canonicalItems.map(candidate => ({id:candidate.id, plate:candidate.plate, x:candidate.x, y:candidate.y})),
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

// Kept as an items-only adapter for existing model consumers. The storage
// paths use applySnapshotCommand so completed records commit atomically.
export function applyCommand(items: Pancake[], command: Command, now: number): Pancake[] {
  if (command.type === "undo") throw new KitchenError("invalid_state", "操作の取り消しにはボード状態が必要です。");
  if (command.type === "reset") throw new KitchenError("invalid_state", "盤面の初期化にはボード状態が必要です。");
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
