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
# ./.ssh/OpenCloud is relative to your home directory there, exactly as it is
# typed by hand after logging in.

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

# Config lives outside the repo (XDG), so nothing personal is ever committed.
CONFIG_FILE="${DEVICE_ACCESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/device-access/config}"

FLAG_USER=""          # -u, highest precedence
FLAG_KEY=""           # -i, highest precedence
JUMP_HOST=""          # -j; empty = derive from the device name
REMOTE_CMD=""         # -c; empty = interactive session
DRY_RUN=0
RECONFIGURE=0
SAVE=0

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die()  { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

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

# ---------- Prerequisites ----------

command -v ssh >/dev/null 2>&1 || die "ssh is not in PATH."

# ---------- Config file ----------

CFG_USER=""
CFG_KEY=""

# Parsed line by line on purpose — the file is never sourced, so a stray line
# in it can never execute anything.
load_config() {
  [[ -r "$CONFIG_FILE" ]] || return 0
  local line key val esc="'\\''"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; val="${line#*=}"
    key="${key//[[:space:]]/}"
    # strip one layer of surrounding single quotes, if present
    if [[ "$val" == \'*\' ]]; then
      val="${val#\'}"; val="${val%\'}"; val="${val//"$esc"/\'}"
    fi
    case "$key" in
      user) CFG_USER="$val" ;;
      key)  CFG_KEY="$val"  ;;
    esac
  done < "$CONFIG_FILE"
}

save_config() {
  local u="$1" k="$2" dir
  dir="$(dirname "$CONFIG_FILE")"
  mkdir -p "$dir" && chmod 700 "$dir" 2>/dev/null || true
  # single-quote the values so spaces and specials survive a round trip
  {
    printf '# device-access — written by %s, edit freely\n' "$SCRIPT_NAME"
    printf "user='%s'\n" "${u//\'/\'\\\'\'}"
    printf "key='%s'\n"  "${k//\'/\'\\\'\'}"
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  info "Saved to $CONFIG_FILE — you won't be asked again."
}

# Asks for both values (offering the current ones as defaults) and stores them.
configure() {
  local cur_u="${1:-}" cur_k="${2:-}" u="" k=""

  printf '\n'
  info "Setup — asked once, then stored in $CONFIG_FILE"
  printf '      The key path is the one seen ON THE JUMP HOST; a relative path\n'
  printf '      is relative to your home directory there (e.g. ./.ssh/mykey).\n\n'

  while [[ -z "$u" ]]; do
    read -rp "Login used on the devices${cur_u:+ [$cur_u]}: " u \
      || die "Setup aborted (input ended)."
    u="${u//[[:space:]]/}"
    [[ -z "$u" && -n "$cur_u" ]] && u="$cur_u"
    [[ -z "$u" ]] && warn "Login must not be empty."
  done

  while [[ -z "$k" ]]; do
    read -rp "SSH key path${cur_k:+ [$cur_k]}: " k \
      || die "Setup aborted (input ended)."
    k="${k//[[:space:]]/}"
    [[ -z "$k" && -n "$cur_k" ]] && k="$cur_k"
    [[ -z "$k" ]] && warn "Key path must not be empty."
  done

  save_config "$u" "$k"
  CFG_USER="$u"; CFG_KEY="$k"
  printf '\n'
}

load_config

if (( RECONFIGURE )); then
  configure "$CFG_USER" "$CFG_KEY"
fi

# Precedence: flag > environment > config file.
SSH_USER="${FLAG_USER:-${DEVICE_SSH_USER:-$CFG_USER}}"
SSH_KEY="${FLAG_KEY:-${DEVICE_SSH_KEY:-$CFG_KEY}}"

# Nothing stored and nothing given -> first run.
if [[ -z "$SSH_USER" || -z "$SSH_KEY" ]]; then
  configure "$SSH_USER" "$SSH_KEY"
  SSH_USER="${FLAG_USER:-${DEVICE_SSH_USER:-$CFG_USER}}"
  SSH_KEY="${FLAG_KEY:-${DEVICE_SSH_KEY:-$CFG_KEY}}"
fi

# --save promotes this run's values to the stored defaults.
if (( SAVE )); then
  save_config "$SSH_USER" "$SSH_KEY"
fi

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

# ---------- Connect ----------

while true; do
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
