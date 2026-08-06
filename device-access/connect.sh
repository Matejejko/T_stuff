#!/usr/bin/env bash
#
# connect.sh — two-hop SSH into a lab network device.
#
# You give it the full device name (e.g. ffm1-oob-leaf3). The script derives
# the jump host from the part before the first hyphen (ffm1), connects there
# with a plain `ssh <jump>` (login and key handled by your local ~/.ssh/config),
# and from there opens the second SSH to the device with an explicit key:
#
#   ssh -t ffm1 -- ssh -i ./.ssh/OpenCloud mpapaj@ffm1-oob-leaf3
#
# The key path is resolved ON THE JUMP HOST, not locally — which is why the
# default stays the relative ./.ssh/OpenCloud, exactly as it is typed by hand
# after logging in.
#
# The device name can be passed as an argument or entered at the prompt;
# everything else has a default that can be overridden by a flag or an
# environment variable.

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

# Defaults — overridable via environment variables and flags.
SSH_USER="${DEVICE_SSH_USER:-mpapaj}"
SSH_KEY="${DEVICE_SSH_KEY:-./.ssh/OpenCloud}"
JUMP_HOST=""          # empty = derive from the device name
REMOTE_CMD=""         # empty = interactive session
DRY_RUN=0

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die()  { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options] [device]

  device              full device name, e.g. ffm1-oob-leaf3
                      (if omitted, the script prompts for it)

Options:
  -u, --user USER     login on the device (default: $SSH_USER)
  -i, --key PATH      SSH key, path as seen ON THE JUMP HOST
                      (default: $SSH_KEY)
  -j, --jump HOST     explicit jump host instead of deriving it
  -c, --command CMD   run a command on the device and exit (non-interactive)
  -n, --dry-run       print the resulting ssh command without running it
  -h, --help          this help

Environment: DEVICE_SSH_USER, DEVICE_SSH_KEY

Examples:
  $SCRIPT_NAME ffm1-oob-leaf3
  $SCRIPT_NAME -u admin ffm2-oob-spine2
  $SCRIPT_NAME -c 'show version' ffm1-oob-leaf3
EOF
}

# ---------- Argument parsing ----------

DEVICE=""
while (( $# > 0 )); do
  case "$1" in
    -u|--user)    [[ -n "${2:-}" ]] || die "Option $1 requires a value."; SSH_USER="$2";   shift 2 ;;
    -i|--key)     [[ -n "${2:-}" ]] || die "Option $1 requires a value."; SSH_KEY="$2";    shift 2 ;;
    -j|--jump)    [[ -n "${2:-}" ]] || die "Option $1 requires a value."; JUMP_HOST="$2";  shift 2 ;;
    -c|--command) [[ -n "${2:-}" ]] || die "Option $1 requires a value."; REMOTE_CMD="$2"; shift 2 ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    --)           shift; break ;;
    -*)           die "Unknown option: $1 (see $SCRIPT_NAME -h)" ;;
    *)
      [[ -z "$DEVICE" ]] || die "More than one device name given ('$DEVICE', '$1')."
      DEVICE="$1"; shift ;;
  esac
done
[[ $# -eq 0 ]] || { [[ -z "$DEVICE" ]] && DEVICE="$1" && shift; }
[[ $# -eq 0 ]] || die "Unexpected extra arguments: $*"

# ---------- Prerequisites ----------

command -v ssh >/dev/null 2>&1 || die "ssh is not in PATH."

# ---------- Device name (validation loop) ----------

# RFC 1123 host label; on top of that it must contain at least one hyphen —
# without one there is no jump host to derive and this would be a direct login.
DEVICE_RE='^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$'

while true; do
  if [[ -z "$DEVICE" ]]; then
    read -rp "Device name (e.g. ffm1-oob-leaf3): " DEVICE \
      || die "No device name given (input ended). Pass it as an argument instead."
    DEVICE="${DEVICE//[[:space:]]/}"
  fi

  if [[ -z "$DEVICE" ]]; then
    warn "Device name must not be empty."
    continue
  fi
  if [[ ! "$DEVICE" =~ $DEVICE_RE ]]; then
    warn "Invalid host name: letters, digits and hyphens only (max 63 characters)."
    DEVICE=""; continue
  fi
  if [[ -z "$JUMP_HOST" && "$DEVICE" != *-* ]]; then
    warn "'$DEVICE' has no hyphen, so there is nothing to derive the jump host from."
    warn "Give the full name (e.g. ffm1-oob-leaf3) or set one explicitly with -j."
    DEVICE=""; continue
  fi
  break
done

# Jump host = everything before the first hyphen (ffm1-oob-leaf3 -> ffm1).
JUMP="${JUMP_HOST:-${DEVICE%%-*}}"

# ---------- Build the command ----------

# The remote command is assembled on the jump host, so every argument is
# escaped with %q — the device name and key path cannot be re-split into
# multiple words or interpreted by the jump host's shell.
REMOTE_SSH="$(printf 'ssh -i %q %q@%q' "$SSH_KEY" "$SSH_USER" "$DEVICE")"
if [[ -n "$REMOTE_CMD" ]]; then
  REMOTE_SSH+=" $(printf '%q' "$REMOTE_CMD")"
fi

# -t forces TTY allocation even with a command after it — without it the
# second hop would not open an interactive session on the device.
SSH_ARGS=(ssh -t "$JUMP" -- "$REMOTE_SSH")

info "Device   : $DEVICE"
info "Jump host: $JUMP"
info "Login    : $SSH_USER"
info "Key      : $SSH_KEY (path as seen on the jump host)"
[[ -n "$REMOTE_CMD" ]] && info "Command  : $REMOTE_CMD"

if (( DRY_RUN )); then
  # Printed in a form that can be pasted straight into a shell.
  printf "ssh -t %s -- '%s'\n" "$JUMP" "${REMOTE_SSH//\'/\'\\\'\'}"
  exit 0
fi

info "Connecting to $DEVICE via $JUMP ..."
exec "${SSH_ARGS[@]}"
