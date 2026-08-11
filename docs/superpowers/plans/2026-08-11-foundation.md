# your-server-board — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a working, deployed fork of gethomepage/homepage — connected to the real Proxmox host with live data — as the foundation the Disks & SMART, Backups, Auth/TOTP, and Alerting/History plans build on next.

**Architecture:** Fork gethomepage/homepage (Next.js Pages Router, GPL-3.0) on GitHub as `your-server-board`, merge in this project's planning docs, add a new restricted-SSH utility for SMART/disk data (nothing in upstream does this), and deploy as a Docker container on `lxc200` (10.0.1.104) via Dockge, wired to a real Proxmox API token and a forced-command-restricted SSH key.

**Tech Stack:** Next.js 16 (Pages Router), React 19, Node 22, pnpm (only — `npx only-allow pnpm` blocks npm/yarn), Vitest, `ssh2` (new dependency), Docker.

## Global Constraints

- Node 22, pnpm only — never use npm/yarn in any command.
- Build via `pnpm run build` (invokes `next build --webpack` — Turbopack is explicitly not used upstream).
- Test via `pnpm test` (Vitest, `vitest run`).
- License is GPL-3.0 (inherited from upstream) — keep `LICENSE` as-is, document fork provenance, do not relicense anything.
- No hardcoded homelab-specific values (IPs, tokens, node names) in application code — everything server-specific lives in `config/*.yaml`, gitignored, following upstream's existing `CONF_DIR` convention (`src/utils/config/config.js`).
- No in-app settings UI — config is hand-edited YAML, matching every other Homepage integration.
- Repo: public GitHub repo `your-server-board` under the `pavel-z-ostravy` account, forked from `gethomepage/homepage`.
- Deploy target: Docker container on `lxc200` (10.0.1.104), managed via the existing Dockge instance, on port **3050** (host) → 3000 (container) — independent of the existing `lxc-automat` service on port 8091, no cutover.

---

### Task 1: Fork & Bootstrap

**Files:**
- Create (on GitHub): `pavel-z-ostravy/your-server-board` (fork of `gethomepage/homepage`)
- Modify: `package.json` (name, version)
- Create: `NOTICE.md`
- Move: `docs/superpowers/specs/2026-08-11-your-server-board-design.md` and this plan file into the forked repo

**Interfaces:**
- Produces: a working local clone at `/Users/pavel/DevVault/projects/your-server-board` with `origin` = the new fork, `upstream` = `gethomepage/homepage`, checked out on branch `dev`, existing test suite passing, dev server confirmed booting.

- [ ] **Step 1: Fork the repo on GitHub with a custom name, cloned to a fresh directory**

```bash
cd /Users/pavel/DevVault/projects
gh repo fork gethomepage/homepage --fork-name your-server-board --clone --remote -- your-server-board-app
```

Expected: creates `github.com/pavel-z-ostravy/your-server-board`, clones it into `./your-server-board-app`, sets `origin` to the fork and `upstream` to `gethomepage/homepage`, checked out on `dev` (the fork's default branch).

- [ ] **Step 2: Carry over the design spec and this plan into the fork**

```bash
mkdir -p /Users/pavel/DevVault/projects/your-server-board-app/docs/superpowers/specs
mkdir -p /Users/pavel/DevVault/projects/your-server-board-app/docs/superpowers/plans
cp /Users/pavel/DevVault/projects/your-server-board/docs/superpowers/specs/2026-08-11-your-server-board-design.md \
   /Users/pavel/DevVault/projects/your-server-board-app/docs/superpowers/specs/
cp /Users/pavel/DevVault/projects/your-server-board/docs/superpowers/plans/2026-08-11-foundation.md \
   /Users/pavel/DevVault/projects/your-server-board-app/docs/superpowers/plans/
cd /Users/pavel/DevVault/projects/your-server-board-app
echo ".superpowers/" >> .gitignore
git add docs .gitignore
git commit -m "docs: carry over design spec and foundation plan from planning phase"
```

- [ ] **Step 3: Swap directories so the fork becomes the canonical project directory**

```bash
mv /Users/pavel/DevVault/projects/your-server-board /Users/pavel/DevVault/projects/your-server-board-planning.bak
mv /Users/pavel/DevVault/projects/your-server-board-app /Users/pavel/DevVault/projects/your-server-board
cd /Users/pavel/DevVault/projects/your-server-board
```

(The `.bak` directory is kept, not deleted, in case anything needs to be recovered from the planning-only repo — safe to delete later once everything is confirmed carried over.)

- [ ] **Step 4: Install dependencies and verify the existing test suite passes (clean baseline)**

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install --frozen-lockfile
pnpm test
```

Expected: all existing upstream tests pass. This is our clean baseline — any test failure introduced later is ours to fix, not inherited.

- [ ] **Step 5: Verify the dev server boots**

```bash
pnpm dev &
sleep 5
curl -s http://localhost:3000/api/healthcheck
kill %1
```

Expected: `up`.

- [ ] **Step 6: Minimal fork branding + GPL provenance notice**

Edit `package.json`:
```json
{
  "name": "your-server-board",
  "version": "0.1.0",
  ...
}
```
(keep every other field as-is)

Create `NOTICE.md`:
```markdown
# Notice

your-server-board is a derivative work of [gethomepage/homepage](https://github.com/gethomepage/homepage),
licensed under the GNU General Public License v3.0 (see `LICENSE`).

This fork adds:
- Disks & SMART health monitoring (auto-detected, not in upstream)
- Backup lifecycle management for Proxmox VMs/CTs (list, run, download, delete, retention)
- Quick VM/CT actions (start/stop/reboot)
- TOTP-based 2FA login
- SMART/disk/backup-failure alerting

Everything else is unmodified or lightly modified upstream Homepage functionality,
available under its original GPL-3.0 terms.
```

- [ ] **Step 7: Commit and push**

```bash
git add package.json NOTICE.md
git commit -m "chore: rebrand fork as your-server-board, add GPL provenance notice"
git push origin dev
```

- [ ] **Step 8: Confirm the repo is public**

```bash
gh repo view pavel-z-ostravy/your-server-board --json visibility --jq .visibility
```

Expected: `PUBLIC` (forks of public repos are public by default on GitHub, but confirm rather than assume).

---

### Task 2: Restricted SSH client for SMART & disk enumeration

**Files:**
- Create: `src/utils/ssh/smartClient.js`
- Create: `src/utils/ssh/smartClient.test.js`
- Modify: `package.json` (adds `ssh2` dependency)
- Create: `deploy/proxmox-smart-helper.sh`
- Create: `deploy/SSH_SETUP.md`

**Interfaces:**
- Produces: `listBlockDevices(sshConfig) -> Promise<{blockdevices: Array}>` and `getSmartData(sshConfig, devicePath) -> Promise<object>`, where `sshConfig = { host, port?, username, privateKeyPath }`. These are the functions the Disks & SMART plan (next) will import and call from an API route — no UI here.

- [ ] **Step 1: Write the failing test**

```javascript
// src/utils/ssh/smartClient.test.js
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeClient extends EventEmitter {
  connect() {
    setImmediate(() => this.emit("ready"));
  }

  exec(command, callback) {
    const stream = new FakeStream();
    setImmediate(() => {
      callback(null, stream);
      if (command.startsWith("lsblk")) {
        stream.emit("data", Buffer.from('{"blockdevices":[{"name":"sda"}]}'));
      } else {
        stream.emit("data", Buffer.from('{"model_name":"Test"}'));
      }
      stream.emit("close", 0);
    });
  }

  end() {}
}

vi.mock("ssh2", () => ({
  Client: vi.fn(() => new FakeClient()),
}));

const { getSmartData, listBlockDevices } = await import("./smartClient");

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "/config/ssh/id_smart" };

describe("smartClient", () => {
  it("lists block devices via lsblk", async () => {
    const result = await listBlockDevices(sshConfig);
    expect(result.blockdevices).toEqual([{ name: "sda" }]);
  });

  it("fetches SMART data for a valid device path", async () => {
    const result = await getSmartData(sshConfig, "/dev/sda");
    expect(result.model_name).toBe("Test");
  });

  it("rejects device paths outside the allowed pattern", async () => {
    await expect(getSmartData(sshConfig, "/dev/sda; rm -rf /")).rejects.toThrow(/unsafe device path/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/utils/ssh/smartClient.test.js`
Expected: FAIL — `Cannot find module './smartClient'` (or similar, since the file doesn't exist yet).

- [ ] **Step 3: Add the `ssh2` dependency**

```bash
pnpm add ssh2
```

- [ ] **Step 4: Write the implementation**

```javascript
// src/utils/ssh/smartClient.js
import { readFileSync } from "node:fs";

import { Client } from "ssh2";

const DEVICE_PATTERN = /^\/dev\/(sd[a-z]|nvme\d+n\d+)$/;

function execCommand(sshConfig, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code) => {
              conn.end();
              if (code !== 0) {
                reject(new Error(`Command exited with code ${code}: ${stderr}`));
                return;
              }
              resolve(stdout);
            })
            .on("data", (data) => {
              stdout += data.toString();
            });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
        });
      })
      .on("error", reject)
      .connect({
        host: sshConfig.host,
        port: sshConfig.port ?? 22,
        username: sshConfig.username,
        privateKey: readFileSync(sshConfig.privateKeyPath),
      });
  });
}

export async function listBlockDevices(sshConfig) {
  const output = await execCommand(sshConfig, "lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA");
  return JSON.parse(output);
}

export async function getSmartData(sshConfig, devicePath) {
  if (!DEVICE_PATTERN.test(devicePath)) {
    throw new Error(`Refusing to query unsafe device path: ${devicePath}`);
  }
  const output = await execCommand(sshConfig, `smartctl -j -a ${devicePath}`);
  return JSON.parse(output);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/utils/ssh/smartClient.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the host-side forced-command script**

```bash
#!/bin/sh
# deploy/proxmox-smart-helper.sh
#
# Installed at /usr/local/bin/your-server-board-smart-helper.sh on the Proxmox
# host and bound to a dedicated SSH key via a forced `command=` entry in
# authorized_keys. That key can NEVER run anything except the two exact
# operations below, regardless of what the client requests — OpenSSH ignores
# the client's requested command when `command=` is set and exposes it only
# via $SSH_ORIGINAL_COMMAND, which this script validates before acting on it.
set -eu

cmd="$SSH_ORIGINAL_COMMAND"

case "$cmd" in
  "lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA")
    exec lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA
    ;;
  "smartctl -j -a /dev/sd"[a-z])
    device="/dev/sd${cmd##*/dev/sd}"
    exec smartctl -j -a "$device"
    ;;
  "smartctl -j -a /dev/nvme"[0-9]n[0-9])
    device="/dev/${cmd##*/dev/}"
    exec smartctl -j -a "$device"
    ;;
  *)
    echo "refused: command not permitted for this key" >&2
    exit 1
    ;;
esac
```

- [ ] **Step 7: Document the host-side setup**

```markdown
<!-- deploy/SSH_SETUP.md -->
# Restricted SSH key setup (Proxmox host)

This key can only run `lsblk` or `smartctl -j -a <device>` — nothing else —
enforced server-side by a forced command, not just by client-side discipline.

1. Generate a dedicated keypair (run on your workstation, not the Proxmox host):
   ```bash
   ssh-keygen -t ed25519 -f ./your-server-board-smart-key -N "" -C "your-server-board-smart-reader"
   ```

2. Copy `deploy/proxmox-smart-helper.sh` to the Proxmox host and make it executable:
   ```bash
   scp deploy/proxmox-smart-helper.sh proxmox:/usr/local/bin/your-server-board-smart-helper.sh
   ssh proxmox 'chmod 755 /usr/local/bin/your-server-board-smart-helper.sh'
   ```

3. Append the public key to `/root/.ssh/authorized_keys` on the Proxmox host,
   prefixed with the forced command and restriction flags:
   ```
   command="/usr/local/bin/your-server-board-smart-helper.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...<paste-generated-pubkey-here> your-server-board-smart-reader
   ```

   SMART data requires raw block device access, which in practice means root
   on Proxmox — there's no standard non-root group for it. The forced command
   is what makes this safe to expose behind a public tunnel: the key is root,
   but it is *only* able to run the two whitelisted read-only commands above.

4. Copy the **private** key into this app's config volume as `config/ssh/id_smart`
   (gitignored — never commit it). The app reads it via `privateKeyPath` in
   `config/proxmox.yaml`.
```

- [ ] **Step 8: Commit**

```bash
git add src/utils/ssh/smartClient.js src/utils/ssh/smartClient.test.js package.json pnpm-lock.yaml \
        deploy/proxmox-smart-helper.sh deploy/SSH_SETUP.md
git commit -m "feat: add restricted SSH client for SMART/disk enumeration"
```

---

### Task 3: Deploy to lxc200 with real Proxmox connectivity

**Files:**
- Create: `docker-compose.yml`
- Create (on `lxc200`, not committed): `config/proxmox.yaml`, `config/ssh/id_smart`
- Modify: `.gitignore` (exclude `config/*.yaml` except a documented example, exclude `config/ssh/`)

**Interfaces:**
- Consumes: `getProxmoxConfig()` from `src/utils/config/proxmox.js` (already exists upstream, unmodified), `listBlockDevices`/`getSmartData` from Task 2.
- Produces: a running container reachable at `http://10.0.1.104:3050`, registered as a Dockge stack, with a real Proxmox VE widget on the dashboard showing live cluster data — proof the whole pipeline (fork → build → deploy → real credentials → real data) works before any new UI is built on top of it.

- [ ] **Step 1: Update `.gitignore` for secrets**

```bash
cat >> .gitignore << 'EOF'

# your-server-board: server-specific secrets, never commit
config/proxmox.yaml
config/ssh/
EOF
git add .gitignore
git commit -m "chore: gitignore server-specific config and SSH secrets"
```

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  your-server-board:
    build: .
    container_name: your-server-board
    restart: unless-stopped
    ports:
      - "3050:3000"
    volumes:
      - ./config:/app/config
    environment:
      - HOMEPAGE_ALLOWED_HOSTS=10.0.1.104:3050
```

```bash
git add docker-compose.yml
git commit -m "feat: add docker-compose for lxc200 deployment"
git push origin dev
```

- [ ] **Step 3: Clone the repo onto lxc200**

```bash
ssh lxc200 'git clone https://github.com/pavel-z-ostravy/your-server-board.git /opt/your-server-board'
```

- [ ] **Step 4: Create a Proxmox API token**

```bash
ssh proxmox 'pveum user token add root@pam your-server-board --privsep 0'
```

Expected output includes a `full-tokenid` (`root@pam!your-server-board`) and a `value` (the secret) — copy both, the secret is shown only once.

> **Follow-up flagged, not done here:** this token inherits full `root@pam` privileges (`--privsep 0`). Before exposing this dashboard publicly via Cloudflare Tunnel, replace it with a token bound to a custom Proxmox role scoped to exactly what's needed (VM/CT read+power+backup, datastore read+allocate) — deferred because guessing exact `pveum` privilege-string names here risks a wrong, silently-broken ACL; verify the precise privilege names against `pveum role add --help` / current Proxmox docs when doing this.

- [ ] **Step 5: Set up the restricted SMART SSH key on the real Proxmox host**

Follow `deploy/SSH_SETUP.md` end-to-end using the real `proxmox` SSH alias in place of generic placeholders. Confirm it works before moving on:

```bash
ssh -i ./your-server-board-smart-key -o 'ProxyCommand=none' root@10.0.1.9 lsblk
```

Expected: JSON block device list, even though the client asked for plain `lsblk` — proves the forced command is intercepting and substituting correctly.

- [ ] **Step 6: Write `config/proxmox.yaml` on lxc200**

```bash
ssh lxc200 'mkdir -p /opt/your-server-board/config/ssh'
scp ./your-server-board-smart-key lxc200:/opt/your-server-board/config/ssh/id_smart
ssh lxc200 'chmod 600 /opt/your-server-board/config/ssh/id_smart'
```

Then create `/opt/your-server-board/config/proxmox.yaml` on lxc200 (via `ssh lxc200` + a heredoc or editor) with the real values:

```yaml
pve:
  url: https://10.0.1.9:8006
  token: root@pam!your-server-board
  secret: <the-secret-value-from-step-4>
```

- [ ] **Step 7: Add the Proxmox VE widget to `config/services.yaml`** (also created on lxc200, following upstream's existing `services.yaml` skeleton/format)

```yaml
- Infrastructure:
    - Proxmox VE:
        icon: proxmox.svg
        widget:
          type: proxmox
          url: https://10.0.1.9:8006
          username: root@pam!your-server-board
          password: <the-secret-value-from-step-4>
```

- [ ] **Step 8: Build and start the stack**

```bash
ssh lxc200 'cd /opt/your-server-board && docker compose up -d --build'
```

- [ ] **Step 9: Register the stack in Dockge**

Open the Dockge UI (`http://10.0.1.104:5001`), confirm `your-server-board` appears as a discovered stack (Dockge auto-discovers compose projects under its configured stacks directory — if `/opt/your-server-board` isn't under that directory, move the clone there instead and redo Step 3/6/8 from that path).

---

### Task 4: End-to-end verification & handoff

**Files:** none (verification only)

- [ ] **Step 1: Confirm the container is healthy**

```bash
ssh lxc200 'docker ps --filter name=your-server-board'
curl -s http://10.0.1.104:3050/api/healthcheck
```

Expected: container `Up (healthy)`, healthcheck returns `up`.

- [ ] **Step 2: Confirm live Proxmox data renders**

Open `http://10.0.1.104:3050` in a browser. Expected: the Proxmox VE widget shows real data from the actual cluster (VM/CT counts, CPU/mem) — not placeholder text.

- [ ] **Step 3: Confirm the restricted SMART SSH path works from inside the app's environment**

```bash
ssh lxc200 'docker exec your-server-board node -e "
const { listBlockDevices } = require(\"./src/utils/ssh/smartClient.js\");
listBlockDevices({ host: \"10.0.1.9\", username: \"root\", privateKeyPath: \"/app/config/ssh/id_smart\" })
  .then((r) => console.log(JSON.stringify(r)))
  .catch((e) => { console.error(e); process.exit(1); });
"'
```

Expected: real JSON block device list from the Proxmox host (`sda`, `sdc`, etc.), proving `smartClient.js` works against the real restricted key end-to-end, not just against the mocked test.

- [ ] **Step 4: Document what's next**

Update the repo's `README.md` with a short "Status" section noting: Foundation deployed and live; Disks & SMART, Backups, TOTP auth, and Alerting/History are tracked as separate follow-up plans in `docs/superpowers/plans/`, not yet implemented. Commit.

```bash
git add README.md
git commit -m "docs: note foundation deployment status and upcoming plans"
git push origin dev
```
