import createLogger from "utils/logger";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxBackups");

function parseVolidStorage(volid) {
  const separatorIndex = volid.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed volid: ${volid}`);
  }
  return volid.slice(0, separatorIndex);
}

async function pveGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

async function pvePost(pveConfig, path, formFields) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = {
    Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body = new URLSearchParams(formFields).toString();
  const [status, , data] = await httpProxy(url, { method: "POST", headers, body });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

async function pveDelete(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "DELETE", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

export async function listBackupStorages(pveConfig, node) {
  const storages = await pveGet(pveConfig, `nodes/${encodeURIComponent(node)}/storage`);
  return (storages ?? [])
    .filter((s) => typeof s.content === "string" && s.content.split(",").includes("backup"))
    .map((s) => ({ storage: s.storage, prunePolicy: s["prune-backups"] ?? null }));
}

export async function listBackupsForVm(pveConfig, node, vmid) {
  const storages = await listBackupStorages(pveConfig, node);
  const results = await Promise.allSettled(
    storages.map(async ({ storage, prunePolicy }) => {
      const content = await pveGet(
        pveConfig,
        `nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=backup`,
      );
      return (content ?? [])
        .filter((entry) => String(entry.vmid) === String(vmid))
        .map((entry) => ({
          volid: entry.volid,
          size: entry.size ?? null,
          ctime: entry.ctime ?? null,
          notes: entry.notes ?? null,
          storage,
          prunePolicy,
        }));
    }),
  );

  const backups = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      backups.push(...result.value);
    } else {
      logger.error(
        "Failed to list backup content on storage %s for node %s:",
        storages[index].storage,
        node,
        result.reason,
      );
    }
  });
  return backups;
}

export async function startBackup(pveConfig, node, vmid, storage) {
  const upid = await pvePost(pveConfig, `nodes/${encodeURIComponent(node)}/vzdump`, {
    vmid: String(vmid),
    storage,
    mode: "snapshot",
    compress: "zstd",
  });
  return { upid };
}

export async function pollBackupTask(pveConfig, node, upid) {
  const status = await pveGet(pveConfig, `nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
  return { status: status.status, exitstatus: status.exitstatus ?? null };
}

export async function deleteBackup(pveConfig, node, volid) {
  const storage = parseVolidStorage(volid);
  await pveDelete(
    pveConfig,
    `nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`,
  );
}
