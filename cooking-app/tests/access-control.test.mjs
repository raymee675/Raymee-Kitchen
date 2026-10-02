import test from "node:test";
import assert from "node:assert/strict";
import { isLocalhostAccess, isLoopbackAddress } from "../server/access-control.mjs";

test("localhost access accepts IPv4, IPv6, and IPv4-mapped loopback only", () => {
  for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(address), true);
  for (const address of ["192.168.1.20", "172.18.1.10", "::ffff:192.168.1.20", "unknown"]) assert.equal(isLoopbackAddress(address), false);
});

test("localhost-only routes require both a loopback peer and a localhost URL", () => {
  const accepted = new URL("http://localhost:8780/api/admin/status");
  assert.equal(isLocalhostAccess("127.0.0.1", accepted, 8780), true);
  assert.equal(isLocalhostAccess("::1", new URL("http://[::1]:8780/admin"), 8780), true);
  assert.equal(isLocalhostAccess("192.168.1.20", accepted, 8780), false);
  assert.equal(isLocalhostAccess("127.0.0.1", new URL("http://attacker.example:8780/admin"), 8780), false);
  assert.equal(isLocalhostAccess("127.0.0.1", new URL("http://localhost:8781/admin"), 8780), false);
});
