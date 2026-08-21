// QEMU's net0 config string has the MAC as the value of the FIRST
// key=value pair, e.g. "virtio=AA:BB:CC:11:22:33,bridge=vmbr0" — the key
// name is the configured NIC model (virtio, e1000, ...) and varies, so this
// only relies on position, never the key name itself.
export function extractMacFromQemuNet0(net0) {
  if (!net0) return null;
  const firstPair = net0.split(",")[0];
  const value = firstPair.split("=")[1];
  if (!value || !/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(value)) return null;
  return value;
}

// LXC's net0 config string has an explicit hwaddr=<MAC> key, found anywhere
// in the comma-separated list — a different shape than QEMU's, not
// interchangeable with extractMacFromQemuNet0.
export function extractMacFromLxcNet0(net0) {
  if (!net0) return null;
  const match = net0.match(/(?:^|,)hwaddr=([0-9A-Fa-f:]{17})(?:,|$)/);
  return match ? match[1] : null;
}

// Shared by both LXC's /interfaces (ip-address-type: "inet"/"inet6") and the
// QEMU guest agent's network-get-interfaces (ip-address-type: "ipv4"/"ipv6")
// — the caller supplies which literal string means "IPv4" in its data,
// since the two real Proxmox API shapes disagree on it.
export function findIPv4ByMac(interfaces, mac, ipv4Type) {
  if (!mac) return null;
  const normalizedMac = mac.toLowerCase();
  const iface = (interfaces ?? []).find((entry) => entry["hardware-address"]?.toLowerCase() === normalizedMac);
  if (!iface) return null;
  const ipv4Entry = (iface["ip-addresses"] ?? []).find((addr) => addr["ip-address-type"] === ipv4Type);
  return ipv4Entry?.["ip-address"] ?? null;
}
