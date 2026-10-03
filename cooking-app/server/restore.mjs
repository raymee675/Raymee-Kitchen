import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { normalizeCompletionItems, normalizeExecutionRecords, normalizePancakes, OVAL_RX, OVAL_RY } from "../lib/kitchen-model.ts";

const input = process.argv[2];
if (!input) {
  console.error("使い方: npm run restore:pc -- <SQLiteバックアップファイル>");
  process.exit(2);
}

const sourcePath = resolve(input);
const defaultDatabasePath = fileURLToPath(new URL("../data-pc/kitchen.sqlite", import.meta.url));
const targetPath = resolve(process.env.KITCHEN_DB_PATH || defaultDatabasePath);
mkdirSync(dirname(targetPath), { recursive: true });
const suffix = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-") + "-" + randomUUID().slice(0, 8);
const stagingPath = resolve(dirname(targetPath), ".restore-" + suffix + ".sqlite");
const previousPath = resolve(dirname(targetPath), basename(targetPath, ".sqlite") + ".before-restore-" + suffix + ".sqlite");

function assertDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const check = database.prepare("PRAGMA integrity_check").get();
    if (check?.integrity_check !== "ok") throw new Error("SQLiteの整合性チェックに失敗しました。");
    const row = database.prepare("SELECT revision, state FROM boards WHERE id = 'main'").get();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new Error("鉄板ボードのデータが見つからないか、形式が正しくありません。");
    }
    validateBoardState(row.state);
  } finally {
    database.close();
  }
}

function validateBoardState(serialized) {
  let state;
  try {
    state = JSON.parse(serialized);
  } catch {
    throw new Error("鉄板ボードのデータが見つからないか、形式が正しくありません。");
  }

  const legacy = Array.isArray(state);
  if (!legacy && (!state || typeof state !== "object" || Array.isArray(state)
    || !Array.isArray(state.items) || !Array.isArray(state.records)
    || (state.completionItems !== undefined && !Array.isArray(state.completionItems)))) {
    throw new Error("鉄板ボードのデータが見つからないか、形式が正しくありません。");
  }
  const items = legacy ? state : state.items;
  const records = legacy ? [] : state.records;
  const completionItems = legacy || state.completionItems === undefined ? [] : state.completionItems;
  const ids = new Set();
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !uuidV4.test(item.id)
      || (item.plate !== 1 && item.plate !== 2)
      || typeof item.x !== "number" || !Number.isFinite(item.x) || item.x < OVAL_RX + 0.02 || item.x > 1 - OVAL_RX - 0.02
      || typeof item.y !== "number" || !Number.isFinite(item.y) || item.y < OVAL_RY + 0.02 || item.y > 1 - OVAL_RY - 0.02
      || typeof item.duration !== "number" || !Number.isSafeInteger(item.duration)
      || (item.temperature !== undefined && (typeof item.temperature !== "number" || !Number.isSafeInteger(item.temperature)))
      || !(item.startedAt === null || (typeof item.startedAt === "number" && Number.isFinite(item.startedAt) && item.startedAt >= 0))
      || typeof item.version !== "number" || !Number.isSafeInteger(item.version) || item.version < 1
      || ids.has(item.id)) {
      throw new Error("鉄板ボードのお好み焼きデータが正しくありません。");
    }
    ids.add(item.id);
  }

  try {
    // These normalizers validate interval structure without changing the
    // serialized state that SQLite's backup API copies to the restore file.
    normalizePancakes(items);
    const normalizedRecords = normalizeExecutionRecords(records);
    const normalizedCompletionItems = normalizeCompletionItems(completionItems, normalizedRecords);
    if (normalizedRecords.some(record => !uuidV4.test(record.id))) {
      throw new Error("実行記録のお好み焼きIDが正しくありません。");
    }
    if (items.some(item => normalizedRecords.some(record => record.id === item.id))) {
      throw new Error("鉄板ボードと実行記録でお好み焼きIDが重複しています。");
    }
    if (normalizedCompletionItems.some(item => items.some(active => active.id === item.id))) {
      throw new Error("完成ボックスと鉄板ボードでお好み焼きIDが重複しています。");
    }
  } catch {
    throw new Error("鉄板ボードまたは実行記録のデータが正しくありません。");
  }
}

function normalizeDatabase(path) {
  const database = new DatabaseSync(path);
  try {
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy) throw new Error("SQLiteのWALを確定できませんでした。");
    database.exec("PRAGMA journal_mode=DELETE");
  } finally {
    database.close();
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = path + suffix;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
}

if (sourcePath === targetPath) throw new Error("現在のDBそのものではなく、backups内のファイルを指定してください。");
if (!existsSync(sourcePath)) throw new Error("バックアップファイルが見つかりません: " + sourcePath);
const movedFiles = [];
try {
  assertDatabase(sourcePath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, stagingPath);
  } finally {
    source.close();
  }
  normalizeDatabase(stagingPath);
  assertDatabase(stagingPath);

  if (existsSync(targetPath)) {
    normalizeDatabase(targetPath);
    assertDatabase(targetPath);
    renameSync(targetPath, previousPath);
    movedFiles.push([targetPath, previousPath]);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = targetPath + suffix;
      if (!existsSync(sidecar)) continue;
      renameSync(sidecar, previousPath + suffix);
      movedFiles.push([sidecar, previousPath + suffix]);
    }
  }
  renameSync(stagingPath, targetPath);
  console.log("SQLiteデータを復元しました: " + targetPath);
  if (movedFiles.length) console.log("復元前のDBを保管しました: " + previousPath);
} catch (error) {
  for (const [original, archived] of movedFiles.reverse()) {
    if (!existsSync(original) && existsSync(archived)) renameSync(archived, original);
  }
  throw error;
} finally {
  if (existsSync(stagingPath)) rmSync(stagingPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = stagingPath + suffix;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
}
