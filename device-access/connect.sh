#!/usr/bin/env bash
#
# connect.sh — two-hop SSH into a lab network device.
#
# You give it the full device name (e.g. ffm1-oob-leaf3). The script derives
# the jump host from the part before the first hyphen (ffm1), connects there
# with a plain `ssh <jump>` (login and key handled by your local ~/.ssh/config),
# and from there opens the second SSH to the device with an explicit key:
#
#   ssh -t ffm1 -- ssh -i <key> <login>@ffm1-oob-leaf3
#
# The login and the key path are asked for once on the first run and stored in
# a config file outside the repo; after that the script only ever asks for the
# device name. They are asked for again only if the connection fails, or when
# you force it with -R. Nothing personal is hardcoded in this file.
#
# The key path is resolved ON THE JUMP HOST, not locally — a relative path like
# ./.ssh/mykey is relative to your home directory there, exactly as it is typed
# by hand after logging in.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh" || { printf '[ERROR] common.sh not found next to %s\n' "$SCRIPT_NAME" >&2; exit 1; }

FLAG_USER=""          # -u, highest precedence
FLAG_KEY=""           # -i, highest precedence
JUMP_HOST=""          # -j; empty = derive from the device name
REMOTE_CMD=""         # -c; empty = interactive session
DRY_RUN=0
RECONFIGURE=0
SAVE=0

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options] [device]

  device               full device name, e.g. ffm1-oob-leaf3
                       (if omitted, the script prompts for it)

Options:
  -u, --user USER      login on the device, just for this run
  -i, --key PATH       SSH key, path as seen ON THE JUMP HOST, just for this run
      --save           store the -u / -i values as the new defaults
  -R, --reconfigure    ask for login and key again and store them
  -j, --jump HOST      explicit jump host instead of deriving it
  -c, --command CMD    run a command on the device and exit (non-interactive)
  -n, --dry-run        print the resulting ssh command without running it
  -h, --help           this help

Login and key are asked for on the first run and stored in
  $CONFIG_FILE
After that only the device name is ever asked for. If a connection fails the
script offers to fix them on the spot.

Precedence: -u / -i  >  DEVICE_SSH_USER / DEVICE_SSH_KEY  >  config file.

Examples:
  $SCRIPT_NAME ffm1-oob-leaf3
  $SCRIPT_NAME -i './.ssh/other_key' ffm2-oob-spine2   # one-off key (quote it:
                                                       # the path is remote)
  $SCRIPT_NAME -i './.ssh/other_key' --save ffm2-oob-spine2
  $SCRIPT_NAME -R                                      # change stored values
  $SCRIPT_NAME -c 'show version' ffm1-oob-leaf3

To pull inventory data off a device instead of logging in, see collect.sh.
EOF
}

# ---------- Argument parsing ----------

DEVICE=""
while (( $# > 0 )); do
  case "$1" in
    -u|--user)        [[ -n "${2:-}" ]] || die "Option $1 requires a value."; FLAG_USER="$2";  shift 2 ;;
    -i|--key)         [[ -n "${2:-}" ]] || die "Option $1 requires a value."; FLAG_KEY="$2";   shift 2 ;;
    -j|--jump)        [[ -n "${2:-}" ]] || die "Option $1 requires a value."; JUMP_HOST="$2";  shift 2 ;;
    -c|--command)     [[ -n "${2:-}" ]] || die "Option $1 requires a value."; REMOTE_CMD="$2"; shift 2 ;;
    --save)           SAVE=1; shift ;;
    -R|--reconfigure) RECONFIGURE=1; shift ;;
    -n|--dry-run)     DRY_RUN=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    --)               shift; break ;;
    -*)               die "Unknown option: $1 (see $SCRIPT_NAME -h)" ;;
    *)
      [[ -z "$DEVICE" ]] || die "More than one device name given ('$DEVICE', '$1')."
      DEVICE="$1"; shift ;;
  esac
done
[[ $# -eq 0 ]] || { [[ -z "$DEVICE" ]] && DEVICE="$1" && shift; }
[[ $# -eq 0 ]] || die "Unexpected extra arguments: $*"

command -v ssh >/dev/null 2>&1 || die "ssh is not in PATH."

resolve_credentials "$FLAG_USER" "$FLAG_KEY" "$RECONFIGURE" "$SAVE"

if [[ -n "$DEVICE" ]]; then
  valid_device "$DEVICE" "$JUMP_HOST" || DEVICE=""
fi
[[ -n "$DEVICE" ]] || DEVICE="$(prompt_device "$JUMP_HOST")"

JUMP="$(jump_for "$DEVICE" "$JUMP_HOST")"

# ---------- Connect ----------

while true; do
  REMOTE_SSH="$(build_remote_ssh "$DEVICE" "$REMOTE_CMD")"

  # -t forces TTY allocation even with a command after it — without it the
  # second hop would not open an interactive session on the device.
  SSH_ARGS=(ssh -t "$JUMP" -- "$REMOTE_SSH")

  info "Device   : $DEVICE"
  info "Jump host: $JUMP"
  info "Login    : $SSH_USER"
  info "Key      : $SSH_KEY (path as seen on the jump host)"
  [[ -n "$REMOTE_CMD" ]] && info "Command  : $REMOTE_CMD"

  if (( DRY_RUN )); then
    printable_ssh "$JUMP" "$REMOTE_SSH"
    exit 0
  fi

  info "Connecting to $DEVICE via $JUMP ..."
  RC=0
  "${SSH_ARGS[@]}" || RC=$?

  # 255 is ssh's own failure code (the session itself never started): unknown
  # host, refused connection, or — the case worth acting on — wrong login or
  # key on the device. Anything else is the remote side's exit code and is
  # passed through untouched.
  if (( RC == 255 )) && [[ -t 0 ]]; then
    warn "SSH failed. Either the jump host '$JUMP' is unreachable, or the"
    warn "login/key is wrong for '$DEVICE' (currently $SSH_USER, $SSH_KEY)."
    ANSWER=""
    read -rp "Change login/key and try again? [y/N]: " ANSWER || ANSWER=""
    if [[ "$ANSWER" =~ ^[Yy]([Ee][Ss])?$ ]]; then
      configure "$SSH_USER" "$SSH_KEY"
      SSH_USER="$CFG_USER"; SSH_KEY="$CFG_KEY"
      continue
    fi
  fi

  exit "$RC"
done
