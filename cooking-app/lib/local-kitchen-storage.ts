import { INITIAL_BOARD_GENERATION, LEGACY_OVAL_RX, LEGACY_OVAL_RY, isPancakeId, normalizeBoardData, type CompletionItem, type ExecutionRecord, type Pancake, type Snapshot, type StoredPancake, type UndoEntry } from "./kitchen-model";

const siteSegment = typeof window === "undefined"
  ? "root"
  : encodeURIComponent(window.location.pathname.split("/").filter(Boolean)[0] ?? "root");
export const LOCAL_BOARD_KEY = `teppan-timer:${siteSegment}:single-phone-board:v1`;
export const LOCAL_BOARD_SCHEMA = 6;

type StoredBoard = {
  schemaVersion: number;
  revision: number;
  generation: number;
  items: Pancake[];
  records: ExecutionRecord[];
  completionItems: CompletionItem[];
  nextPancakeOrdinal: number;
  undoHistory: UndoEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validItem(value: unknown): value is StoredPancake {
  if (!isRecord(value)) return false;
  return isPancakeId(value.id)
    && (value.plate === 1 || value.plate === 2)
    && typeof value.x === "number" && Number.isFinite(value.x) && value.x >= LEGACY_OVAL_RX + 0.02 && value.x <= 1 - LEGACY_OVAL_RX - 0.02
    && typeof value.y === "number" && Number.isFinite(value.y) && value.y >= LEGACY_OVAL_RY + 0.02 && value.y <= 1 - LEGACY_OVAL_RY - 0.02
    && typeof value.duration === "number" && Number.isSafeInteger(value.duration)
    && (value.temperature === undefined || (typeof value.temperature === "number" && Number.isSafeInteger(value.temperature)))
    && (value.startedAt === null || (typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt >= 0))
    && typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 1;
}

function decode(raw: string | null): StoredBoard {
  if (raw === null) return { schemaVersion: LOCAL_BOARD_SCHEMA, revision: 0, generation:INITIAL_BOARD_GENERATION, items: [], records: [], completionItems: [], nextPancakeOrdinal:1, undoHistory:[] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("保存データを読み取れません。データを保護するため、盤面を初期化せず操作を停止しました。");
  }

  const legacyItems = Array.isArray(value) ? value : null;
  const rawSchemaVersion = isRecord(value) ? value.schemaVersion : 1;
  const schemaVersion = typeof rawSchemaVersion === "number" ? rawSchemaVersion : Number.NaN;
  const revision = isRecord(value) ? value.revision : 0;
  const rawGeneration = isRecord(value) ? value.generation : undefined;
  const rawItems = legacyItems ?? (isRecord(value) ? value.items : null);
  const rawNextPancakeOrdinal = isRecord(value) ? value.nextPancakeOrdinal : undefined;
  const hasRecords = schemaVersion >= 2 && schemaVersion <= LOCAL_BOARD_SCHEMA;
  const rawRecords = isRecord(value) && hasRecords ? value.records : [];
  const rawCompletionItems = isRecord(value) && schemaVersion >= 3 && schemaVersion <= LOCAL_BOARD_SCHEMA ? value.completionItems : [];
  const rawUndoHistory = isRecord(value) && schemaVersion >= 5 && schemaVersion <= LOCAL_BOARD_SCHEMA ? value.undoHistory : undefined;
  if ((!legacyItems && (!isRecord(value) || !Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1 || (schemaVersion as number) > LOCAL_BOARD_SCHEMA))
    || !Number.isSafeInteger(revision) || (revision as number) < 0
    || (schemaVersion === LOCAL_BOARD_SCHEMA && (!Number.isSafeInteger(rawGeneration) || (rawGeneration as number) < INITIAL_BOARD_GENERATION))
    || !Array.isArray(rawItems) || !rawItems.every(validItem)
    || (hasRecords && !Array.isArray(rawRecords))
    || (schemaVersion >= 3 && schemaVersion <= LOCAL_BOARD_SCHEMA && !Array.isArray(rawCompletionItems))
    || (schemaVersion >= 4 && schemaVersion <= LOCAL_BOARD_SCHEMA && rawNextPancakeOrdinal !== undefined
      && (!Number.isSafeInteger(rawNextPancakeOrdinal) || (rawNextPancakeOrdinal as number) < 1 || (rawNextPancakeOrdinal as number) > 193))
    || (schemaVersion >= 5 && schemaVersion <= LOCAL_BOARD_SCHEMA && !Array.isArray(rawUndoHistory))) {
    throw new Error("保存データの形式が現在のアプリに対応していません。データを保護するため、操作を停止しました。");
  }

  const ids = new Set<string>();
  for (const item of rawItems) {
    if (ids.has(item.id)) throw new Error("保存データに重複したIDがあります。データを保護するため、操作を停止しました。");
    ids.add(item.id);
  }

  const board = normalizeBoardData({
    items:rawItems,
    records:rawRecords,
    completionItems:rawCompletionItems,
    generation:schemaVersion === LOCAL_BOARD_SCHEMA ? rawGeneration : undefined,
    nextPancakeOrdinal:schemaVersion >= 4 ? rawNextPancakeOrdinal : undefined,
    undoHistory:rawUndoHistory,
  });
  return {
    schemaVersion: LOCAL_BOARD_SCHEMA,
    revision: revision as number,
    ...board,
  };
}

type BoardStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;

export function readLocalBoard(storage: BoardStorage = window.localStorage): Snapshot {
  const raw = storage.getItem(LOCAL_BOARD_KEY);
  const stored = decode(raw);
  if (raw !== null && storage.setItem) {
    const canonical = JSON.stringify(stored);
    if (raw !== canonical) {
      try {
        storage.setItem(LOCAL_BOARD_KEY, canonical);
      } catch {
        // A failed opportunistic migration must not hide a readable saved board.
      }
    }
  }
  return { revision: stored.revision, generation:stored.generation, items: stored.items, records:stored.records, completionItems:stored.completionItems, nextPancakeOrdinal:stored.nextPancakeOrdinal, undoHistory:stored.undoHistory, serverNow: Date.now() };
}

export function writeLocalBoard(snapshot: Snapshot, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  const board = normalizeBoardData({
    items:snapshot.items,
    records:snapshot.records ?? [],
    completionItems:snapshot.completionItems ?? [],
    generation:snapshot.generation,
    nextPancakeOrdinal:snapshot.nextPancakeOrdinal,
    undoHistory:snapshot.undoHistory ?? [],
  });
  const stored: StoredBoard = {
    schemaVersion: LOCAL_BOARD_SCHEMA,
    revision: snapshot.revision,
    ...board,
  };
  storage.setItem(LOCAL_BOARD_KEY, JSON.stringify(stored));
}
