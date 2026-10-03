import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { applyCommand, KitchenError, normalizePancakes, parseCommand } from "../lib/kitchen-model.ts";

const defaultDatabasePath = fileURLToPath(new URL("../data-pc/kitchen.sqlite", import.meta.url));
const file = resolve(process.env.KITCHEN_DB_PATH || defaultDatabasePath);
mkdirSync(dirname(file), { recursive: true });
export const database = new DatabaseSync(file);
const digest = value => createHash("sha256").update(value).digest("hex");
database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
database.exec([
  "CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY NOT NULL, actor TEXT NOT NULL, request_hash TEXT NOT NULL, applied_revision INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, session_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_seen_at INTEGER);",
  "CREATE TABLE IF NOT EXISTS enrollment_codes (code_hash TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, device_id TEXT, management_id TEXT, canceled_at INTEGER);",
  "CREATE INDEX IF NOT EXISTS idx_devices_session ON devices(session_hash, expires_at, revoked_at);",
].join("\n"));

function ensureColumn(table, column, declaration) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
ensureColumn("devices", "last_seen_at", "INTEGER");
ensureColumn("enrollment_codes", "management_id", "TEXT");
ensureColumn("enrollment_codes", "canceled_at", "INTEGER");
database.prepare("UPDATE enrollment_codes SET management_id = lower(hex(randomblob(16))) WHERE management_id IS NULL").run();
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_management_id ON enrollment_codes(management_id)");
database.prepare("INSERT OR IGNORE INTO boards (id, revision, state, updated_at) VALUES ('main', 0, '[]', ?)").run(Date.now());

// The PC itself is a built-in terminal. Loopback requests are mapped to this
// record by the HTTP server and never need a one-time enrollment code.
const localDeviceId = "localhost";
database.prepare("INSERT OR IGNORE INTO devices (id, label, session_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)")
  .run(localDeviceId, "このPC（localhost）", digest("reserved-localhost-terminal-v1"), Date.now(), Number.MAX_SAFE_INTEGER);

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readBoard() {
  const row = database.prepare("SELECT revision, state FROM boards WHERE id = 'main'").get();
  if (!row) throw new Error("Board row is missing");
  return row;
}

function migrateBoardItems() {
  const row = readBoard();
  const items = normalizePancakes(JSON.parse(row.state));
  const state = JSON.stringify(items);
  if (state !== row.state) {
    // Canonicalize legacy per-item durations and supply the default temperature
    // without changing board revision or item versions.
    database.prepare("UPDATE boards SET state = ? WHERE id = 'main' AND revision = ?").run(state, row.revision);
  }
}
migrateBoardItems();

export function readSnapshot() {
  const serverReceivedAt = Date.now();
  const row = readBoard();
  return { revision: row.revision, items: normalizePancakes(JSON.parse(row.state)), serverReceivedAt, serverNow: Date.now() };
}

export function executeCommand(input, actor) {
  const command = parseCommand(input);
  const requestHash = digest(JSON.stringify(command));
  const previous = database.prepare("SELECT actor, request_hash, applied_revision FROM operations WHERE id = ?");
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = previous.get(command.operationId);
    if (receipt) {
      if (receipt.actor !== actor || !secureEqual(receipt.request_hash, requestHash)) {
        throw new KitchenError("operation_reused", "操作IDが重複しました。もう一度操作してください。");
      }
      const snapshot = readSnapshot();
      database.exec("COMMIT");
      return { ...snapshot, operationId: command.operationId, appliedRevision: receipt.applied_revision };
    }

    const row = readBoard();
    const receivedAt = Date.now();
    const items = applyCommand(JSON.parse(row.state), command, receivedAt);
    const revision = row.revision + 1;
    database.prepare("INSERT INTO operations (id, actor, request_hash, applied_revision, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(command.operationId, actor, requestHash, revision, receivedAt);
    database.prepare("UPDATE boards SET state = ?, revision = ?, updated_at = ? WHERE id = 'main' AND revision = ?")
      .run(JSON.stringify(items), revision, receivedAt, row.revision);
    const snapshot = readSnapshot();
    database.exec("COMMIT");
    return { ...snapshot, operationId: command.operationId, appliedRevision: revision };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function registrationCode() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function createEnrollmentCode() {
  const code = registrationCode();
  const createdAt = Date.now();
  const expiresAt = createdAt + 15 * 60_000;
  const managementId = randomBytes(16).toString("hex");
  database.prepare("DELETE FROM enrollment_codes WHERE created_at <= ? AND (expires_at <= ? OR used_at IS NOT NULL OR canceled_at IS NOT NULL)")
    .run(createdAt - 30 * 24 * 60 * 60_000, createdAt);
  database.prepare("INSERT INTO enrollment_codes (code_hash, created_at, expires_at, management_id) VALUES (?, ?, ?, ?)")
    .run(digest(code), createdAt, expiresAt, managementId);
  return { id: managementId, code: code.match(/.{1,4}/g).join("-"), createdAt, expiresAt };
}

export function enrollDevice(code, label) {
  const cleanCode = code.toUpperCase().replaceAll("-", "").replaceAll(" ", "");
  if (!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(cleanCode)) throw new KitchenError("invalid_code", "登録コードを確認してください。", 400);
  const cleanLabel = typeof label === "string" ? label.trim().slice(0, 40) : "";
  if (!cleanLabel) throw new KitchenError("invalid_label", "端末名を入力してください。", 400);

  const now = Date.now();
  const codeHash = digest(cleanCode);
  const session = randomBytes(32).toString("base64url");
  const deviceId = randomBytes(16).toString("hex");
  database.exec("BEGIN IMMEDIATE");
  try {
    const token = database.prepare("SELECT code_hash FROM enrollment_codes WHERE code_hash = ? AND used_at IS NULL AND canceled_at IS NULL AND expires_at > ?").get(codeHash, now);
    if (!token || !secureEqual(token.code_hash, codeHash)) throw new KitchenError("invalid_code", "登録コードが違うか、期限切れです。", 401);
    database.prepare("INSERT INTO devices (id, label, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(deviceId, cleanLabel, digest(session), now, now + 30 * 24 * 60 * 60_000);
    database.prepare("UPDATE enrollment_codes SET used_at = ?, device_id = ? WHERE code_hash = ? AND used_at IS NULL AND canceled_at IS NULL")
      .run(now, deviceId, codeHash);
    database.exec("COMMIT");
    return { deviceId, session };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function findDevice(session) {
  if (!session || !/^[A-Za-z0-9_-]{40,50}$/.test(session)) return null;
  return database.prepare("SELECT id, label, expires_at FROM devices WHERE session_hash = ? AND expires_at > ? AND revoked_at IS NULL")
    .get(digest(session), Date.now()) || null;
}

export function listDevices() {
  return database.prepare("SELECT id, label, created_at, expires_at, revoked_at, last_seen_at FROM devices ORDER BY CASE WHEN id = 'localhost' THEN 0 ELSE 1 END, created_at DESC").all();
}

export function touchDevice(identifier, at = Date.now()) {
  database.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)")
    .run(at, identifier, at - 15_000);
}

export function listEnrollmentCodes() {
  const now = Date.now();
  return database.prepare(`SELECT management_id AS id, created_at, expires_at, used_at, device_id, canceled_at,
    CASE WHEN canceled_at IS NOT NULL THEN 'canceled'
         WHEN used_at IS NOT NULL THEN 'used'
         WHEN expires_at <= ? THEN 'expired'
         ELSE 'pending' END AS state
    FROM enrollment_codes WHERE created_at > ? ORDER BY created_at DESC`)
    .all(now, now - 30 * 24 * 60 * 60_000);
}

export function cancelEnrollmentCode(identifier) {
  const result = database.prepare("UPDATE enrollment_codes SET canceled_at = ? WHERE management_id = ? AND used_at IS NULL AND canceled_at IS NULL AND expires_at > ?")
    .run(Date.now(), identifier, Date.now());
  return Number(result.changes);
}

export function revokeDevice(identifier) {
  if (identifier === localDeviceId) return 0;
  const now = Date.now();
  const result = database.prepare("UPDATE devices SET revoked_at = ? WHERE id <> ? AND (id = ? OR label = ?) AND revoked_at IS NULL")
    .run(now, localDeviceId, identifier, identifier);
  return Number(result.changes);
}

export function findLocalDevice() {
  return database.prepare("SELECT id, label, expires_at FROM devices WHERE id = ?").get(localDeviceId) || null;
}

export const storagePath = file;
