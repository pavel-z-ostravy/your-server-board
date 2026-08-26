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

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

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
  "ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu")
    exec ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu
    ;;
  "pct exec "[0-9]*" -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu")
    vmid="${cmd#pct exec }"
    vmid="${vmid% -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu}"
    case "$vmid" in
      ''|*[!0-9]*)
        echo "refused: invalid vmid" >&2
        exit 1
        ;;
    esac
    exec pct exec "$vmid" -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu
    ;;
  "pct exec "[0-9]*" -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'")
    vmid="${cmd#pct exec }"
    # NOTE: the %-suffix here MUST wrap the apostrophe-bearing text in double
    # quotes ("'...'") rather than using bare single quotes, unlike how it
    # might look natural to write. A bare single quote inside a ${var%pattern}
    # word acts as a real quote-operator (and gets consumed during pattern
    # processing) rather than matching a literal apostrophe in $vmid — with
    # bare quotes here, this stripping silently no-ops on every input
    # (legitimate or not), leaving $vmid equal to the full unstripped string,
    # which then always fails the numeric-only check below (fails closed, not
    # a security hole, but the whole branch becomes permanently non-functional).
    # Verified by executing both forms directly: the bare-quote version left
    # $vmid unstripped for a real "pct exec 200 -- sh -c '...'" input; the
    # double-quote-wrapped version below correctly stripped it to "200".
    vmid=${vmid% -- sh -c "'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'"}
    case "$vmid" in
      ''|*[!0-9]*)
        echo "refused: invalid vmid" >&2
        exit 1
        ;;
    esac
    exec pct exec "$vmid" -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'
    ;;
  "cat-backup "*)
    rest="${cmd#cat-backup }"
    storage="${rest%%:*}"
    aftercolon="${rest#*:}"
    case "$storage" in
      ''|*[!A-Za-z0-9_-]*)
        echo "refused: invalid storage id" >&2
        exit 1
        ;;
    esac
    case "$aftercolon" in
      backup/vzdump-qemu-*)
        vmtype_prefix="vzdump-qemu-"
        vmtype=qemu
        ;;
      backup/vzdump-lxc-*)
        vmtype_prefix="vzdump-lxc-"
        vmtype=lxc
        ;;
      *)
        echo "refused: invalid backup path" >&2
        exit 1
        ;;
    esac
    filename="${aftercolon#backup/}"
    vmid_and_suffix="${filename#"$vmtype_prefix"}"
    vmid="${vmid_and_suffix%%-*}"
    case "$vmid" in
      ''|*[!0-9]*)
        echo "refused: invalid vmid in backup filename" >&2
        exit 1
        ;;
    esac
    suffix="${vmid_and_suffix#"$vmid"-}"
    if [ "$vmtype" = qemu ]; then
      case "$suffix" in
        [0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].vma|\
        [0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].vma.gz|\
        [0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].vma.zst)
          ;;
        *)
          echo "refused: invalid backup filename" >&2
          exit 1
          ;;
      esac
    else
      case "$suffix" in
        [0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].tar|\
        [0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].tar.gz|\
        [0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].tar.zst)
          ;;
        *)
          echo "refused: invalid backup filename" >&2
          exit 1
          ;;
      esac
    fi
    path=$(pvesm path "${storage}:backup/${filename}") || {
      echo "refused: could not resolve backup path" >&2
      exit 1
    }
    case "$path" in
      /*) ;;
      *)
        echo "refused: resolved path not absolute" >&2
        exit 1
        ;;
    esac
    exec cat "$path"
    ;;
  *)
    echo "refused: command not permitted for this key" >&2
    exit 1
    ;;
esac
