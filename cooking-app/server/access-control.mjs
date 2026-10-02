const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackAddress(address) {
  return loopbackAddresses.has(address || "") || /^127\./.test(address || "") || /^::ffff:127\./i.test(address || "");
}

export function isLocalhostAccess(remoteAddress, url, port) {
  return isLoopbackAddress(remoteAddress)
    && loopbackHostnames.has(url.hostname.toLowerCase())
    && url.port === String(port);
}
