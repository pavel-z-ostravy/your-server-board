// Recursively collects every real (non-swap) mountpoint under a lsblk device
// node, at any depth. "[SWAP]" is lsblk's literal mountpoint value for an
// active swap volume — swap is deliberately excluded from capacity reporting
// (see Global Constraints in the plan this file was built from: lvs reports
// no data_percent for it, and it isn't "data" in the sense this feature
// communicates).
function collectMountpoints(node, acc) {
  if (node.mountpoint && node.mountpoint !== "[SWAP]") {
    acc.push(node.mountpoint);
  }
  for (const child of node.children ?? []) {
    collectMountpoints(child, acc);
  }
}

// Recursively collects the names of every partition-level node under a
// lsblk device node. Only partitions (lsblk type "part") can be LVM
// physical volumes — pvs reports PVs as "/dev/<partition-name>", so this is
// the full set of candidate device names to check against the PV mapping.
function collectPartitionNames(node, acc) {
  if (node.type === "part") {
    acc.push(node.name);
  }
  for (const child of node.children ?? []) {
    collectPartitionNames(child, acc);
  }
}

export function computeDiskCapacity(disk, { dfRows, lvsRows, pvsRows }) {
  const mountpoints = [];
  collectMountpoints(disk, mountpoints);

  const partitionNames = [];
  collectPartitionNames(disk, partitionNames);

  const vgNames = new Set(
    pvsRows.filter((pv) => partitionNames.includes(pv.pvName.replace(/^\/dev\//, ""))).map((pv) => pv.vgName),
  );

  const relevantDf = dfRows.filter((row) => mountpoints.includes(row.target));
  const dfUsed = relevantDf.reduce((sum, row) => sum + row.usedBytes, 0);
  const dfSize = relevantDf.reduce((sum, row) => sum + row.sizeBytes, 0);

  // Only the thin pool's own row carries the aggregate data_percent for
  // everything provisioned inside it — summing the pool's sibling thin
  // volumes (vm-*-disk-*, lv_attr starting with "V") on top would double-count.
  const thinPools = lvsRows.filter((lv) => vgNames.has(lv.vgName) && lv.lvAttr?.[0] === "t");
  const thinUsed = thinPools.reduce((sum, lv) => sum + Math.round((lv.dataPercent / 100) * lv.lvSizeBytes), 0);
  const thinSize = thinPools.reduce((sum, lv) => sum + lv.lvSizeBytes, 0);

  const usedBytes = dfUsed + thinUsed;
  const totalBytes = dfSize + thinSize;

  if (totalBytes === 0) {
    return null;
  }

  return { usedBytes, totalBytes };
}
