// pve-manager's raw version string looks like "pve-manager/9.2.9/aa93fdab516e230b"
// (verified against a live Proxmox 9.2 host's GET /nodes/{node}/status response).
// Extract just the middle "9.2.9" segment for a readable display string, falling
// back to the raw string unchanged if it doesn't match that shape - an unexpected
// but still-present version string is more useful shown as-is than hidden.
export function parsePveVersion(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/^pve-manager\/([^/]+)\//);
  return match ? match[1] : raw;
}

// Picks the host's primary IPv4 address from GET /nodes/{node}/network's
// interface array (verified against a live Proxmox 9.2 host) - the address
// lives on whichever entry has both an "inet" family and a populated
// address field. That's typically the bridge with the IP configured on it,
// not the raw physical NIC underneath it, which has no address field of its
// own. Returns null if no such entry exists or interfaces isn't an array.
export function pickPrimaryIpAddress(interfaces) {
  if (!Array.isArray(interfaces)) return null;
  const match = interfaces.find(
    (iface) =>
      Array.isArray(iface?.families) &&
      iface.families.includes("inet") &&
      typeof iface?.address === "string" &&
      iface.address.length > 0,
  );
  return match ? match.address : null;
}
