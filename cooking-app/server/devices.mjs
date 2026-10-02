import { backup, DatabaseSync } from "node:sqlite";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createEnrollmentCode, database, listDevices, revokeDevice, storagePath } from "./storage.mjs";

const [command, ...args] = process.argv.slice(2);
const port = Number(process.env.KITCHEN_PORT || 8780);

function printHelp() {
  console.log([
    "鉄板タイマー端末管理",
    "",
    "  node server/devices.mjs add                 一回限りの登録コードを発行",
    "  node server/devices.mjs list                登録端末を一覧表示",
    "  node server/devices.mjs revoke <ID|名前>   指定した端末を失効",
    "  node server/devices.mjs backup [保存先]     SQLiteを整合性を保ってバックアップ",
  ].join("\n"));
}

function printDeviceUrls() {
  const found = [];
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      found.push(interfaceName + ": http://" + address.address + ":" + port + "/register");
    }
  }
  const unique = [...new Set(found)];
  if (!unique.length) {
    console.log("端末登録URL: http://<このPCのIPv4アドレス>:" + port + "/register");
    return;
  }
  console.log("登録ページ（スマホをPCのホットスポットに接続し、そのIPv4アドレスを選ぶ）:");
  for (const address of unique) console.log("  " + address);
}

try {
  if (command === "add") {
    const { code, expiresAt } = createEnrollmentCode();
    console.log("このコードは15分で期限切れになり、1台の登録に一度だけ使えます。");
    console.log("登録コード: " + code);
    printDeviceUrls();
    console.log("有効期限: " + new Date(expiresAt).toLocaleString("ja-JP"));
  } else if (command === "list") {
    const devices = listDevices();
    if (!devices.length) console.log("登録端末はありません。");
    for (const device of devices) {
      const state = device.revoked_at ? "停止" : device.expires_at <= Date.now() ? "期限切れ" : "有効";
      console.log([state, device.label, device.id, "期限 " + new Date(device.expires_at).toLocaleString("ja-JP")].join("\t"));
    }
  } else if (command === "revoke" && args[0]) {
    const count = revokeDevice(args.join(" "));
    console.log(count ? count + "台の端末を停止しました。" : "該当する有効な端末がありません。");
  } else if (command === "backup") {
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const destination = resolve(args[0] || ("./backups/kitchen-" + timestamp + ".sqlite"));
    if (destination === storagePath) throw new Error("現在のDB以外の保存先を指定してください。");
    if ([destination, destination + "-wal", destination + "-shm"].some(path => existsSync(path))) {
      throw new Error("保存先がすでに存在します。別のファイル名を指定してください。");
    }
    mkdirSync(dirname(destination), { recursive: true });
    const pages = await backup(database, destination);
    const copy = new DatabaseSync(destination);
    try {
      const checkpoint = copy.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint?.busy) throw new Error("バックアップのWALを確定できませんでした。");
      copy.exec("PRAGMA journal_mode=DELETE");
    } finally {
      copy.close();
    }
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = destination + suffix;
      if (existsSync(sidecar)) rmSync(sidecar);
    }
    console.log("SQLiteバックアップを保存しました: " + destination);
    console.log("保存ページ数: " + pages + "; 元データ: " + storagePath);
  } else {
    printHelp();
    if (command) process.exitCode = 2;
  }
} finally {
  database.close();
}
