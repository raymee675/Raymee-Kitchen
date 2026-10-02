import { MAX_DURATION, MIN_DURATION, OVAL_RX, OVAL_RY, type Pancake, type Snapshot } from "./kitchen-model";

const siteSegment = typeof window === "undefined"
  ? "root"
  : encodeURIComponent(window.location.pathname.split("/").filter(Boolean)[0] ?? "root");
export const LOCAL_BOARD_KEY = `teppan-timer:${siteSegment}:single-phone-board:v1`;
export const LOCAL_BOARD_SCHEMA = 1;

type StoredBoard = {
  schemaVersion: number;
  revision: number;
  items: Pancake[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validItem(value: unknown): value is Pancake {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    && (value.plate === 1 || value.plate === 2)
    && typeof value.x === "number" && Number.isFinite(value.x) && value.x >= OVAL_RX + 0.02 && value.x <= 1 - OVAL_RX - 0.02
    && typeof value.y === "number" && Number.isFinite(value.y) && value.y >= OVAL_RY + 0.02 && value.y <= 1 - OVAL_RY - 0.02
    && typeof value.duration === "number" && Number.isSafeInteger(value.duration) && value.duration >= MIN_DURATION && value.duration <= MAX_DURATION
    && (value.startedAt === null || (typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt >= 0))
    && typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 1;
}

function decode(raw: string | null): StoredBoard {
  if (raw === null) return { schemaVersion: LOCAL_BOARD_SCHEMA, revision: 0, items: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("保存データを読み取れません。データを保護するため、盤面を初期化せず操作を停止しました。");
  }

  if (!isRecord(value) || value.schemaVersion !== LOCAL_BOARD_SCHEMA
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Array.isArray(value.items) || !value.items.every(validItem)) {
    throw new Error("保存データの形式が現在のアプリに対応していません。データを保護するため、操作を停止しました。");
  }

  const ids = new Set<string>();
  for (const item of value.items) {
    if (ids.has(item.id)) throw new Error("保存データに重複したIDがあります。データを保護するため、操作を停止しました。");
    ids.add(item.id);
  }

  return { schemaVersion: LOCAL_BOARD_SCHEMA, revision: value.revision as number, items: value.items };
}

export function readLocalBoard(storage: Pick<Storage, "getItem"> = window.localStorage): Snapshot {
  const stored = decode(storage.getItem(LOCAL_BOARD_KEY));
  return { revision: stored.revision, items: stored.items, serverNow: Date.now() };
}

export function writeLocalBoard(snapshot: Snapshot, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  const stored: StoredBoard = {
    schemaVersion: LOCAL_BOARD_SCHEMA,
    revision: snapshot.revision,
    items: snapshot.items,
  };
  storage.setItem(LOCAL_BOARD_KEY, JSON.stringify(stored));
}
