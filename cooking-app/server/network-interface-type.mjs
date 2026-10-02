export function classifyNetworkInterface(interfaceName, address) {
  const name = String(interfaceName || "").normalize("NFKC").toLocaleLowerCase("ja-JP");

  if (
    /^(local area connection|ローカル エリア接続)\s*\*/.test(name)
    || /(mobile hotspot|hotspot|wi-?fi direct)/.test(name)
    || address === "192.168.137.1"
  ) return "hotspot";

  if (/(vethernet|virtualbox|vmware|vpn|tap|tun|docker|wsl|仮想)/.test(name)) return "other";
  if (/(wi-?fi|wireless|wlan|無線lan)/.test(name)) return "wifi";
  if (/(ethernet|イーサネット)/.test(name)) return "ethernet";
  return "other";
}
