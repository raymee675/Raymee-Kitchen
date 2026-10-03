import { OVAL_RX, OVAL_RY, normalizeCompletionItems, normalizeExecutionRecords, normalizePancakes, type CompletionItem, type ExecutionRecord, type Pancake, type Snapshot, type StoredPancake } from "./kitchen-model";

const siteSegment = typeof window === "undefined"
  ? "root"
  : encodeURIComponent(window.location.pathname.split("/").filter(Boolean)[0] ?? "root");
export const LOCAL_BOARD_KEY = `teppan-timer:${siteSegment}:single-phone-board:v1`;
export const LOCAL_BOARD_SCHEMA = 3;

type StoredBoard = {
  schemaVersion: number;
  revision: number;
  items: Pancake[];
  records: ExecutionRecord[];
  completionItems: CompletionItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validItem(value: unknown): value is StoredPancake {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    && (value.plate === 1 || value.plate === 2)
    && typeof value.x === "number" && Number.isFinite(value.x) && value.x >= OVAL_RX + 0.02 && value.x <= 1 - OVAL_RX - 0.02
    && typeof value.y === "number" && Number.isFinite(value.y) && value.y >= OVAL_RY + 0.02 && value.y <= 1 - OVAL_RY - 0.02
    && typeof value.duration === "number" && Number.isSafeInteger(value.duration)
    && (value.temperature === undefined || (typeof value.temperature === "number" && Number.isSafeInteger(value.temperature)))
    && (value.startedAt === null || (typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt >= 0))
    && typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 1;
}

function decode(raw: string | null): StoredBoard {
  if (raw === null) return { schemaVersion: LOCAL_BOARD_SCHEMA, revision: 0, items: [], records: [], completionItems: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("保存データを読み取れません。データを保護するため、盤面を初期化せず操作を停止しました。");
  }

  const legacyItems = Array.isArray(value) ? value : null;
  const schemaVersion = isRecord(value) ? value.schemaVersion : 1;
  const revision = isRecord(value) ? value.revision : 0;
  const rawItems = legacyItems ?? (isRecord(value) ? value.items : null);
  const hasRecords = schemaVersion === 2 || schemaVersion === LOCAL_BOARD_SCHEMA;
  const rawRecords = isRecord(value) && hasRecords ? value.records : [];
  const rawCompletionItems = isRecord(value) && schemaVersion === LOCAL_BOARD_SCHEMA ? value.completionItems : [];
  if ((!legacyItems && (!isRecord(value) || (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== LOCAL_BOARD_SCHEMA)))
    || !Number.isSafeInteger(revision) || (revision as number) < 0
    || !Array.isArray(rawItems) || !rawItems.every(validItem)
    || (hasRecords && !Array.isArray(rawRecords))
    || (schemaVersion === LOCAL_BOARD_SCHEMA && !Array.isArray(rawCompletionItems))) {
    throw new Error("保存データの形式が現在のアプリに対応していません。データを保護するため、操作を停止しました。");
  }

  const ids = new Set<string>();
  for (const item of rawItems) {
    if (ids.has(item.id)) throw new Error("保存データに重複したIDがあります。データを保護するため、操作を停止しました。");
    ids.add(item.id);
  }

  const records = normalizeExecutionRecords(rawRecords);
  return {
    schemaVersion: LOCAL_BOARD_SCHEMA,
    revision: revision as number,
    items: normalizePancakes(rawItems),
    records,
    completionItems: normalizeCompletionItems(rawCompletionItems, records),
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
  return { revision: stored.revision, items: stored.items, records:stored.records, completionItems:stored.completionItems, serverNow: Date.now() };
}

export function writeLocalBoard(snapshot: Snapshot, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  const records = normalizeExecutionRecords(snapshot.records ?? []);
  const stored: StoredBoard = {
    schemaVersion: LOCAL_BOARD_SCHEMA,
    revision: snapshot.revision,
    items: normalizePancakes(snapshot.items),
    records,
    completionItems: normalizeCompletionItems(snapshot.completionItems ?? [], records),
  };
  storage.setItem(LOCAL_BOARD_KEY, JSON.stringify(stored));
}
