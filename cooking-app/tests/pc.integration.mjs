import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { networkInterfaces } from "node:os";
import { once } from "node:events";

const project = new URL("../", import.meta.url);
const workDir = decodeURIComponent(project.pathname.slice(process.platform === "win32" ? 1 : 0)).replaceAll("/", process.platform === "win32" ? "\\" : "/");
const temporary = await mkdtemp(join(tmpdir(), "teppan-pc-integration-"));
const databasePath = join(temporary, "legacy-kitchen.sqlite");
const now = Date.now();
const existingItem = { id:"30000000-0000-4000-8000-000000000001", plate:1, x:0.5, y:0.5, duration:100, startedAt:null, version:1 };
const legacyToken = randomBytes(32).toString("base64url");
const legacyDeviceId = randomBytes(16).toString("hex");
const legacySessionHash = createHash("sha256").update(legacyToken).digest("hex");

const legacy = new DatabaseSync(databasePath);
legacy.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
  CREATE TABLE operations (id TEXT PRIMARY KEY NOT NULL, actor TEXT NOT NULL, request_hash TEXT NOT NULL, applied_revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE devices (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, session_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
  CREATE TABLE enrollment_codes (code_hash TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, device_id TEXT);`);
legacy.prepare("INSERT INTO boards VALUES ('main', 7, ?, ?)").run(JSON.stringify([existingItem]), now);
legacy.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, NULL)").run(legacyDeviceId,"以前からのスマホ",legacySessionHash,now-1000,now+30*24*60*60_000);
legacy.close();

async function freePort() {
  const { createServer } = await import("node:net");
  const listener=createServer();
  await new Promise((resolve,reject)=>listener.once("error",reject).listen(0,"127.0.0.1",resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  return port;
}
const port=await freePort();
const localOrigin=`http://127.0.0.1:${port}`;
const addresses=Object.values(networkInterfaces()).flatMap(items=>items||[])
  .filter(item=>item.family==="IPv4"&&!item.internal&&!item.address.startsWith("169.254."))
  .map(item=>item.address);

function requestAt(address,path,{method="GET",headers={},body,host}={}) {
  return new Promise((resolve,reject)=>{
    const request=httpRequest({hostname:address,port,path,method,localAddress:address,family:4,headers:{...(host?{Host:host}:{}),...headers}},response=>{
      const chunks=[]; response.on("data",chunk=>chunks.push(chunk));
      response.on("end",()=>resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString("utf8")}));
    });
    request.setTimeout(3500,()=>request.destroy(new Error("integration request timed out")));
    request.on("error",reject);
    if(body) request.write(body);
    request.end();
  });
}

let server;
let serverOutput="";
async function waitForReady() {
  for(let attempt=0;attempt<60;attempt++) {
    if(server.exitCode!==null) throw new Error(`PC server exited early (${server.exitCode}): ${serverOutput}`);
    try { const response=await requestAt("127.0.0.1","/api/health"); if(response.status===200)return; } catch {}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error(`PC server did not become ready: ${serverOutput}`);
}

try {
  server=spawn(process.execPath,["server/index.mjs"],{cwd:workDir,env:{...process.env,KITCHEN_HOST:"0.0.0.0",KITCHEN_PORT:String(port),KITCHEN_DB_PATH:databasePath},windowsHide:true,stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",chunk=>serverOutput+=chunk.toString());
  server.stderr.on("data",chunk=>serverOutput+=chunk.toString());
  await waitForReady();

  const localRoot=await requestAt("127.0.0.1","/");
  assert.equal(localRoot.status,200); assert.match(localRoot.text,/端末管理/);
  const localBoard=await requestAt("127.0.0.1","/api/board");
  assert.equal(localBoard.status,200,"localhost must use its built-in device without a code");
  const localStatus=JSON.parse((await requestAt("127.0.0.1","/api/admin/status")).text);
  assert.ok(localStatus.devices.some(device=>device.id==="localhost"));
  assert.ok(localStatus.devices.some(device=>device.id===legacyDeviceId),"opening an old DB must preserve enrolled devices");
  assert.equal(localStatus.devices.find(device=>device.id===legacyDeviceId).last_seen_at,null,"schema migration adds last-seen without fabricating activity");

  const noOrigin=await requestAt("127.0.0.1","/api/admin/enrollment-codes",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  assert.equal(noOrigin.status,403,"admin mutations require a same-origin browser request");
  const issuedResponse=await requestAt("127.0.0.1","/api/admin/enrollment-codes",{method:"POST",headers:{Origin:localOrigin,"Content-Type":"application/json"},body:"{}"});
  assert.equal(issuedResponse.status,201); const issued=JSON.parse(issuedResponse.text);
  assert.match(issued.code,/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  const privateCodeList=await requestAt("127.0.0.1","/api/admin/enrollment-codes");
  assert.equal(privateCodeList.status,200); assert.equal(privateCodeList.text.includes(issued.code),false,"plaintext enrollment codes must not be listable after issuance");

  let deviceIp=null;
  for(const address of addresses) {
    try { const health=await requestAt(address,"/api/health"); if(health.status===200){deviceIp=address;break;} } catch {}
  }
  if(!deviceIp) throw new Error("A local IPv4 interface could not reach the temporary server for the phone-facing access checks.");
  const mobileOrigin=`http://${deviceIp}:${port}`;
  const unregistered=await requestAt(deviceIp,"/");
  assert.equal(unregistered.status,302); assert.equal(unregistered.headers.location,"/register");
  for(const adminPath of ["/admin","/admin.html","/api/admin/status"]) {
    const denied=await requestAt(deviceIp,adminPath);
    assert.equal(denied.status,404,`non-loopback request must not access ${adminPath}`);
  }
  const spoofedHost=await requestAt(deviceIp,"/api/admin/status",{host:`localhost:${port}`});
  assert.equal(spoofedHost.status,404,"a remote client cannot gain admin access by spoofing Host: localhost");
  const spoofedMutation=await requestAt(deviceIp,"/api/admin/enrollment-codes",{method:"POST",host:`localhost:${port}`,headers:{Origin:localOrigin,"Content-Type":"application/json"},body:"{}"});
  assert.equal(spoofedMutation.status,404,"admin APIs must enforce the socket peer address");

  const legacyAccess=await requestAt(deviceIp,"/api/board",{headers:{Cookie:`teppan_device=${legacyToken}`}});
  assert.equal(legacyAccess.status,200,"existing device sessions remain valid after DB migration");
  const migratedBoard=JSON.parse(legacyAccess.text);
  const migratedItem=migratedBoard.items.find(item=>item.id==="1-1");
  assert.ok(migratedItem,"saved board state must survive schema migration");
  assert.equal(migratedBoard.revision,7,"board revision must survive item normalization");
  assert.equal(migratedItem.duration,90,"legacy timer duration is normalized to the fixed duration");
  assert.equal(migratedItem.temperature,96,"legacy items receive the default temperature");
  assert.deepEqual({plate:migratedItem.plate,x:migratedItem.x,y:migratedItem.y,startedAt:migratedItem.startedAt,version:migratedItem.version},
    {plate:existingItem.plate,x:existingItem.x,y:existingItem.y,startedAt:existingItem.startedAt,version:existingItem.version},
    "legacy item position and state must survive normalization");

  const enrollment=await requestAt(deviceIp,"/api/enroll",{method:"POST",headers:{Origin:mobileOrigin,"Content-Type":"application/json"},body:JSON.stringify({code:issued.code,label:"テストスマホ"})});
  assert.equal(enrollment.status,200); const setCookie=enrollment.headers["set-cookie"]; const cookie=(Array.isArray(setCookie)?setCookie[0]:setCookie)?.split(";")[0]; assert.ok(cookie);
  assert.equal((await requestAt(deviceIp,"/api/enroll",{method:"POST",headers:{Origin:mobileOrigin,"Content-Type":"application/json"},body:JSON.stringify({code:issued.code,label:"二重登録"})})).status,401,"one-time codes cannot be reused");
  const phoneBoard=await requestAt(deviceIp,"/api/board",{headers:{Cookie:cookie}}); assert.equal(phoneBoard.status,200);
  const createdId=randomUUID();
  const command={operationId:randomUUID(),type:"create",id:createdId,plate:2,x:0.2,y:0.2};
  const changed=await requestAt(deviceIp,"/api/board",{method:"POST",headers:{Cookie:cookie,Origin:mobileOrigin,"Content-Type":"application/json"},body:JSON.stringify(command)});
  assert.equal(changed.status,200);
  const createdItem=JSON.parse(changed.text).items.find(item=>item.id==="1-2");
  assert.ok(createdItem);
  assert.equal(createdItem.duration,90); assert.equal(createdItem.temperature,96);

  const deviceId=JSON.parse(enrollment.text).deviceId;
  const revoked=await requestAt("127.0.0.1",`/api/admin/devices/${deviceId}/revoke`,{method:"POST",headers:{Origin:localOrigin,"Content-Type":"application/json"},body:"{}"});
  assert.equal(revoked.status,200); assert.equal(JSON.parse(revoked.text).revoked,true);
  assert.equal((await requestAt(deviceIp,"/api/board",{headers:{Cookie:cookie}})).status,401,"revocation must take effect immediately");

  const canceledCode=JSON.parse((await requestAt("127.0.0.1","/api/admin/enrollment-codes",{method:"POST",headers:{Origin:localOrigin,"Content-Type":"application/json"},body:"{}"})).text);
  const canceled=await requestAt("127.0.0.1",`/api/admin/enrollment-codes/${canceledCode.id}`,{method:"DELETE",headers:{Origin:localOrigin,"Content-Type":"application/json"}});
  assert.equal(canceled.status,200); assert.equal(JSON.parse(canceled.text).canceled,true);
  const canceledEnroll=await requestAt(deviceIp,"/api/enroll",{method:"POST",headers:{Origin:mobileOrigin,"Content-Type":"application/json"},body:JSON.stringify({code:canceledCode.code,label:"取消テスト"})});
  assert.equal(canceledEnroll.status,401,"canceled codes cannot enroll a device");
  console.log("PC integration checks passed: legacy DB migration, localhost auto-device/admin, remote admin denial, enrollment/cancel/revoke, and board persistence.");
} finally {
  if(server && server.exitCode===null) {
    server.kill("SIGTERM");
    await Promise.race([once(server,"exit"),new Promise(resolve=>setTimeout(resolve,5000))]);
    if(server.exitCode===null) server.kill("SIGKILL");
  }
  await rm(temporary,{recursive:true,force:true});
}
