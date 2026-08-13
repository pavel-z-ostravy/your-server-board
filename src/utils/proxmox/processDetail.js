export function parseTopProcesses(stdout, limit = 5) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)$/);
      if (!match) return null;
      const [, pid, cpu, mem, command] = match;
      return { pid: Number(pid), cpuPercent: Number(cpu), memPercent: Number(mem), command };
    })
    .filter((entry) => entry !== null)
    .slice(0, limit);
}

export function parseOsProbe(stdout) {
  const [osReleaseBlock, timestampBlock] = stdout.split("---\n");

  const prettyNameMatch = (osReleaseBlock ?? "").match(/^PRETTY_NAME="?([^"\n]+)"?$/m);
  const prettyName = prettyNameMatch ? prettyNameMatch[1] : null;

  const timestampLine = (timestampBlock ?? "").trim();
  let lastUpdate = null;
  if (timestampLine && timestampLine !== "none" && /^\d+$/.test(timestampLine)) {
    lastUpdate = new Date(Number(timestampLine) * 1000).toISOString();
  }

  return { prettyName, lastUpdate };
}
