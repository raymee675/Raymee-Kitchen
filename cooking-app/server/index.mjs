import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { classifyNetworkInterface } from "./network-interface-type.mjs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalhostAccess, isLoopbackAddress } from "./access-control.mjs";
import { KitchenError } from "../lib/kitchen-model.ts";
import { cancelEnrollmentCode, createEnrollmentCode, database, enrollDevice, executeCommand, findDevice, findLocalDevice, listDevices, listEnrollmentCodes, readSnapshot, revokeDevice, storagePath, touchDevice } from "./storage.mjs";

const root = resolve(fileURLToPath(new URL("../dist-pc", import.meta.url)));
const port = Number(process.env.KITCHEN_PORT || 8780);
const host = process.env.KITCHEN_HOST || "0.0.0.0";
const cookieName = "teppan_device";
const sessionMaxAge = 30 * 24 * 60 * 60;
const enrollAttempts = new Map();
function isLocalProxy(request) {
  return isLoopbackAddress(request.socket.remoteAddress);
}

function requestProtocol(request) {
  if (isLocalProxy(request)) {
    const forwardedProtocol = request.headers["x-forwarded-proto"]?.split(",", 1)[0]?.trim().toLowerCase();
    if (forwardedProtocol === "http" || forwardedProtocol === "https") return forwardedProtocol;
  }
  return request.socket.encrypted ? "https" : "http";
}

function clientAddress(request) {
  if (isLocalProxy(request)) {
    const forwardedAddress = request.headers["cf-connecting-ip"]?.trim();
    if (forwardedAddress && isIP(forwardedAddress)) return forwardedAddress;
  }
  return request.socket.remoteAddress || "unknown";
}

function sendJson(response, body, status = 200, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function cookieValue(request, name) {
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

function deviceFor(request) {
  return findDevice(cookieValue(request, cookieName));
}

function assertSameOrigin(request, url) {
  if (request.headers["sec-fetch-site"] === "cross-site") throw new KitchenError("cross_site", "別のサイトからの操作は許可されません。", 403);
  const origin = request.headers.origin;
  if (origin && origin !== url.origin) throw new KitchenError("origin", "操作元のページを確認してください。", 403);
}

function assertLocalAdminOrigin(request, url) {
  if (!request.headers.origin || !isLocalhostAccess(request.socket.remoteAddress, url, port)) {
    throw new KitchenError("admin_origin", "管理操作はlocalhostの管理画面から実行してください。", 403);
  }
  assertSameOrigin(request, url);
}

async function readBody(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > 2048) throw new KitchenError("too_large", "操作内容が大きすぎます。", 413);
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (Buffer.byteLength(content) > 2048) throw new KitchenError("too_large", "操作内容が大きすぎます。", 413);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new KitchenError("invalid_json", "操作内容を読み取れません。", 400);
  }
}

function allowEnrollmentAttempt(request, response) {
  const key = clientAddress(request);
  const now = Date.now();
  let state = enrollAttempts.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + 10 * 60_000 };
  state.count += 1;
  enrollAttempts.set(key, state);
  if (state.count <= 8) return true;
  sendJson(response, { error: "登録試行が多すぎます。しばらく待ってください。" }, 429, {
    "Retry-After": String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))),
  });
  return false;
}

function mime(path) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
  })[extname(path).toLowerCase()] || "application/octet-stream";
}

function serveFile(request, response, file) {
  response.writeHead(200, {
    "Content-Type": mime(file),
    "Cache-Control": extname(file) === ".html" ? "no-store" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}

function sendFailure(response, error) {
  if (error instanceof KitchenError) {
    sendJson(response, { error: error.message, code: error.code }, error.status);
    return;
  }
  console.error("Kitchen server error:", error);
  sendJson(response, { error: "共有データに接続できません。管理者に確認してください。", code: "unavailable" }, 503);
}

async function handle(request, response) {
  const requestUrl = new URL(request.url || "/", requestProtocol(request) + "://" + (request.headers.host || "localhost"));
  const path = requestUrl.pathname;

  if (path === "/api/health" && request.method === "GET") {
    return sendJson(response, { status: "ok", serverNow: Date.now() });
  }

  if (path.startsWith("/api/admin/")) {
    if (!isLocalhostAccess(request.socket.remoteAddress, requestUrl, port)) return sendJson(response, { error: "管理画面はこのPCからのみ利用できます。" }, 404);
    try {
      if (request.method === "GET" && path === "/api/admin/status") {
        touchDevice("localhost");
        const interfaces = networkInterfaces();
        const registerUrls = [];
        for (const [interfaceName, addresses] of Object.entries(interfaces)) {
          for (const address of addresses || []) {
            if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
            registerUrls.push({ interfaceName, connectionType: classifyNetworkInterface(interfaceName, address.address), url: `http://${address.address}:${port}/register` });
          }
        }
        return sendJson(response, { devices: listDevices(), codes: listEnrollmentCodes(), registerUrls });
      }
      if (path === "/api/admin/enrollment-codes" && request.method === "GET") {
        return sendJson(response, { codes: listEnrollmentCodes() });
      }
      if (path === "/api/admin/enrollment-codes" && request.method === "POST") {
        assertLocalAdminOrigin(request, requestUrl);
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          throw new KitchenError("content_type", "JSON形式が必要です。", 415);
        }
        const { code, ...record } = createEnrollmentCode();
        return sendJson(response, { ...record, code }, 201);
      }
      const codeMatch = path.match(/^\/api\/admin\/enrollment-codes\/([a-f0-9]{32})$/);
      if (codeMatch && request.method === "DELETE") {
        assertLocalAdminOrigin(request, requestUrl);
        const canceled = cancelEnrollmentCode(codeMatch[1]);
        return sendJson(response, { canceled: canceled === 1 }, canceled ? 200 : 404);
      }
      const deviceMatch = path.match(/^\/api\/admin\/devices\/([a-f0-9]{32})\/revoke$/);
      if (deviceMatch && request.method === "POST") {
        assertLocalAdminOrigin(request, requestUrl);
        return sendJson(response, { revoked: revokeDevice(deviceMatch[1]) === 1 });
      }
      return sendJson(response, { error: "管理APIが見つかりません。" }, 404);
    } catch (error) {
      return sendFailure(response, error);
    }
  }

  if (path === "/api/enroll" && request.method === "POST") {
    try {
      assertSameOrigin(request, requestUrl);
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new KitchenError("content_type", "JSON形式が必要です。", 415);
      }
      if (!allowEnrollmentAttempt(request, response)) return;
      const input = await readBody(request);
      const registered = enrollDevice(typeof input?.code === "string" ? input.code : "", input?.label);
      enrollAttempts.delete(clientAddress(request));
      const secure = requestProtocol(request) === "https" ? "; Secure" : "";
      return sendJson(response, { deviceId: registered.deviceId }, 200, {
        "Set-Cookie": cookieName + "=" + registered.session + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + sessionMaxAge + secure,
      });
    } catch (error) {
      return sendFailure(response, error);
    }
  }

  if (path === "/api/board") {
    const localAccess = isLocalhostAccess(request.socket.remoteAddress, requestUrl, port);
    const device = localAccess ? findLocalDevice() : deviceFor(request);
    if (!device) return sendJson(response, { error: "この端末は未登録か、利用期限が切れています。", code: "unauthorized" }, 401);
    try {
      touchDevice(device.id);
      if (request.method === "GET") return sendJson(response, readSnapshot());
      if (request.method !== "POST") return sendJson(response, { error: "この操作には対応していません。" }, 405);
      assertSameOrigin(request, requestUrl);
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new KitchenError("content_type", "JSON形式が必要です。", 415);
      }
      return sendJson(response, executeCommand(await readBody(request), device.id));
    } catch (error) {
      return sendFailure(response, error);
    }
  }

  if (path.startsWith("/api/")) return sendJson(response, { error: "ページが見つかりません。" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, { error: "この操作には対応していません。" }, 405);

  const localAccess = isLocalhostAccess(request.socket.remoteAddress, requestUrl, port);
  if ((path === "/admin" || path.startsWith("/admin/") || path === "/admin.html") && !localAccess) {
    return sendJson(response, { error: "管理画面はこのPCからのみ利用できます。" }, 404);
  }
  if (path === "/" && localAccess) {
    if (!existsSync(resolve(root, "admin.html"))) return sendJson(response, { error: "PC版管理画面がビルドされていません。" }, 503);
    touchDevice("localhost");
    return serveFile(request, response, resolve(root, "admin.html"));
  }
  if ((path === "/register" || path === "/register/") && localAccess) {
    response.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    response.end();
    return;
  }
  if (path === "/" && !localAccess && !deviceFor(request)) {
    response.writeHead(302, { Location: "/register", "Cache-Control": "no-store" });
    response.end();
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return sendJson(response, { error: "ページが見つかりません。" }, 404);
  }
  const candidate = resolve(root, decoded === "/admin" || decoded === "/admin/" ? "admin.html" : "." + decoded);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return sendJson(response, { error: "ページが見つかりません。" }, 404);
  }
  const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : resolve(root, "index.html");
  if (!existsSync(file)) return sendJson(response, { error: "PC版アプリがまだビルドされていません。管理者が起動手順を確認してください。" }, 503);
  return serveFile(request, response, file);
}

const server = createServer((request, response) => {
  void handle(request, response).catch(error => sendFailure(response, error));
});

server.listen(port, host, () => {
  console.log("鉄板タイマー: http://localhost:" + port);
  console.log("登録画面: http://localhost:" + port + "/register");
  console.log("Node.js " + process.version + "; SQLite: " + storagePath);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.close();
    } catch (error) {
      console.error("SQLite shutdown error:", error);
    }
  }));
}
