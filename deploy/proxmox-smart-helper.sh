#!/bin/sh
# deploy/proxmox-smart-helper.sh
#
# Installed at /usr/local/bin/your-server-board-smart-helper.sh on the Proxmox
# host and bound to a dedicated SSH key via a forced `command=` entry in
# authorized_keys. That key can NEVER run anything except the exact
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
  "smartctl -j -a /dev/nvme"*)
    device="/dev/nvme${cmd##*/dev/nvme}"
    case "$device" in
      /dev/nvme[0-9]n[0-9]|/dev/nvme[0-9][0-9]n[0-9]|/dev/nvme[0-9]n[0-9][0-9]|/dev/nvme[0-9][0-9]n[0-9][0-9])
        exec smartctl -j -a "$device"
        ;;
      *)
        echo "refused: unsafe device path" >&2
        exit 1
        ;;
    esac
    ;;
  "df -B1 --output=source,target,fstype,used,size")
    exec df -B1 --output=source,target,fstype,used,size
    ;;
  "lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size")
    exec lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size
    ;;
  "pvs --noheadings -o pv_name,vg_name")
    exec pvs --noheadings -o pv_name,vg_name
    ;;
  *)
    echo "refused: command not permitted for this key" >&2
    exit 1
    ;;
esac
