import test from "node:test";
import assert from "node:assert/strict";
import { classifyNetworkInterface } from "../server/network-interface-type.mjs";

test("Windows Mobile Hotspot adapter names are identified", () => {
  assert.equal(classifyNetworkInterface("Local Area Connection* 12", "192.168.137.1"), "hotspot");
  assert.equal(classifyNetworkInterface("ローカル エリア接続* 12", "192.168.137.1"), "hotspot");
});

test("the Windows Mobile Hotspot address identifies a renamed Wi-Fi adapter", () => {
  assert.equal(classifyNetworkInterface("Wi-Fi 3", "192.168.137.1"), "hotspot");
});

test("ordinary Wi-Fi and Ethernet remain alternative routes", () => {
  assert.equal(classifyNetworkInterface("Wi-Fi", "172.18.1.251"), "wifi");
  assert.equal(classifyNetworkInterface("Ethernet", "192.168.1.25"), "ethernet");
});

test("virtual and VPN adapters are not presented as phone routes", () => {
  assert.equal(classifyNetworkInterface("vEthernet (Default Switch)", "172.20.0.1"), "other");
});
