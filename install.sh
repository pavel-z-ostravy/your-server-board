#!/bin/sh
# install.sh — sets up your-server-board on this machine.
# Run this from a clone of the repo, on whichever machine will run the
# Docker container (it does not need to be your Proxmox host itself).
set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

echo "== your-server-board setup =="
echo

command -v docker >/dev/null 2>&1 || { echo "docker is required but not found. Install Docker first." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose (v2 plugin) is required but not found." >&2; exit 1; }
command -v ssh-keygen >/dev/null 2>&1 || { echo "ssh-keygen is required but not found." >&2; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

# Read just the one variable we need out of .env without sourcing it as
# shell — .env can contain user-supplied text (see the prompt below), and
# `. ./.env` would execute anything written there as shell code on every
# future run, not just this one.
YSB_ALLOWED_HOSTS="$(grep '^YSB_ALLOWED_HOSTS=' .env 2>/dev/null | tail -n1 | cut -d= -f2-)"

if [ -z "$YSB_ALLOWED_HOSTS" ]; then
  printf "Which host:port will you browse this dashboard at? (e.g. 192.168.1.50:3050): "
  read -r allowed_hosts
  if [ -z "$allowed_hosts" ]; then
    echo "YSB_ALLOWED_HOSTS is required — edit .env and re-run this script." >&2
    exit 1
  fi
  # Reject anything outside a safe host:port allowlist before it's ever
  # written to .env. Without this, shell metacharacters typed here would be
  # written verbatim to .env and then executed on the *next* run if .env
  # were ever sourced — and even with sourcing removed above, an
  # unvalidated value could still break out of the sed substitution below
  # (delimiter collision, `&` = whole-match in sed) or corrupt the file.
  case "$allowed_hosts" in
    *[!A-Za-z0-9.:,-]*)
      echo "YSB_ALLOWED_HOSTS may only contain letters, digits, '.', ':', ',', '-' — got: $allowed_hosts" >&2
      exit 1
      ;;
  esac
  # Rewrite via a filtered copy rather than `sed -i` in place: this works
  # whether or not .env already has a YSB_ALLOWED_HOSTS= line (a plain sed
  # substitution silently no-ops — and leaves an effectively-empty
  # HOMEPAGE_ALLOWED_HOSTS — if the line is missing), and avoids `sed -i.bak`,
  # which isn't portable to BusyBox sed.
  grep -v '^YSB_ALLOWED_HOSTS=' .env > .env.tmp || true
  echo "YSB_ALLOWED_HOSTS=${allowed_hosts}" >> .env.tmp
  mv .env.tmp .env
  YSB_ALLOWED_HOSTS="$allowed_hosts"
fi

mkdir -p config/ssh

if [ ! -f config/ssh/id_smart ]; then
  echo
  echo "Generating a restricted SSH key for SMART/disk health queries..."
  ssh-keygen -t ed25519 -f config/ssh/id_smart -N "" -C "your-server-board-smart-reader" >/dev/null
  echo "Generated config/ssh/id_smart (private) and config/ssh/id_smart.pub (public)."
else
  echo "config/ssh/id_smart already exists, skipping key generation."
fi

if [ ! -f config/proxmox.yaml ] && [ -f src/skeleton/proxmox.yaml ]; then
  mkdir -p config
  cp src/skeleton/proxmox.yaml config/proxmox.yaml
  echo "Created config/proxmox.yaml from the template."
elif [ -f config/proxmox.yaml ]; then
  echo "config/proxmox.yaml already exists, skipping template copy."
fi

echo
echo "== Manual step required on your Proxmox host =="
echo "1. Copy deploy/proxmox-smart-helper.sh to your Proxmox host and make it executable:"
echo "     scp deploy/proxmox-smart-helper.sh root@<your-proxmox-host>:/usr/local/bin/your-server-board-smart-helper.sh"
echo "     ssh root@<your-proxmox-host> chmod 755 /usr/local/bin/your-server-board-smart-helper.sh"
echo
echo "2. Append this line to /root/.ssh/authorized_keys on your Proxmox host:"
echo
if [ -f config/ssh/id_smart.pub ]; then
  smart_pubkey="$(cat config/ssh/id_smart.pub)"
else
  # .pub may not have survived a copy/deploy of just the private key —
  # it can always be re-derived from the private key itself.
  smart_pubkey="$(ssh-keygen -y -f config/ssh/id_smart)"
fi
printf '   command="/usr/local/bin/your-server-board-smart-helper.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty %s\n' "$smart_pubkey"
echo
echo "   Full details, including why this is safe to expose publicly: deploy/SSH_SETUP.md"
echo
printf "Press Enter once you've completed the two steps above (or Ctrl+C to do it later and re-run this script): "
read -r _

echo
echo "== Proxmox API connection =="
echo "Edit config/proxmox.yaml with your Proxmox URL and API token (see the"
echo "comments in that file for the format, and README.md for how to create a"
echo "least-privilege API token with 'pveum'). The dashboard will pick it up"
echo "on next restart (docker compose restart)."
echo

echo "== Building and starting the container =="
docker compose up -d --build

echo
echo "Done. Dashboard starting at the host:port you set in YSB_ALLOWED_HOSTS."
echo "Fill in config/proxmox.yaml, then: docker compose restart"
