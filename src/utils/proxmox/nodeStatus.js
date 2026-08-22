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
