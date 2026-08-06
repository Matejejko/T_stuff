#!/usr/bin/env bash
#
# common.sh — shared plumbing for connect.sh and collect.sh.
#
# Sourced, never executed. Provides: logging, the config file (login + key
# asked once and remembered), device-name validation, jump-host derivation
# and the two-hop ssh invocation itself.

# Config lives outside the repo (XDG), so nothing personal is ever committed.
CONFIG_FILE="${DEVICE_ACCESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/device-access/config}"

CFG_USER=""
CFG_KEY=""

info() { printf '[INFO] %s\n' "$*" >&2; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die()  { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

# ---------- Config file ----------

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
    printf '# device-access — written by the scripts, edit freely\n'
    printf "user='%s'\n" "${u//\'/\'\\\'\'}"
    printf "key='%s'\n"  "${k//\'/\'\\\'\'}"
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  info "Saved to $CONFIG_FILE — you won't be asked again."
}

# Asks for both values (offering the current ones as defaults) and stores them.
configure() {
  local cur_u="${1:-}" cur_k="${2:-}" u="" k=""

  printf '\n' >&2
  info "Setup — asked once, then stored in $CONFIG_FILE"
  printf '      The key path is the one seen ON THE JUMP HOST; a relative path\n' >&2
  printf '      is relative to your home directory there (e.g. ./.ssh/mykey).\n\n' >&2

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
  printf '\n' >&2
}

# Resolves SSH_USER / SSH_KEY from, in order: flags, environment, config file.
# Runs the first-time setup if nothing is known yet.
# $1=flag user  $2=flag key  $3=1 to force reconfigure  $4=1 to save the result
resolve_credentials() {
  local flag_user="${1:-}" flag_key="${2:-}" reconfigure="${3:-0}" save="${4:-0}"

  load_config
  (( reconfigure )) && configure "$CFG_USER" "$CFG_KEY"

  SSH_USER="${flag_user:-${DEVICE_SSH_USER:-$CFG_USER}}"
  SSH_KEY="${flag_key:-${DEVICE_SSH_KEY:-$CFG_KEY}}"

  if [[ -z "$SSH_USER" || -z "$SSH_KEY" ]]; then
    configure "$SSH_USER" "$SSH_KEY"
    SSH_USER="${flag_user:-${DEVICE_SSH_USER:-$CFG_USER}}"
    SSH_KEY="${flag_key:-${DEVICE_SSH_KEY:-$CFG_KEY}}"
  fi

  (( save )) && save_config "$SSH_USER" "$SSH_KEY"
  return 0
}

# ---------- Device name ----------

# RFC 1123 host label; on top of that it must contain at least one hyphen —
# without one there is no jump host to derive and this would be a direct login.
DEVICE_RE='^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$'

# $1=device  $2=jump override (may be empty). Echoes nothing, returns 0/1.
valid_device() {
  local dev="$1" jump_override="${2:-}"
  [[ -n "$dev" ]]                              || { warn "Device name must not be empty."; return 1; }
  [[ "$dev" =~ $DEVICE_RE ]]                   || { warn "Invalid host name '$dev': letters, digits and hyphens only (max 63 characters)."; return 1; }
  [[ -n "$jump_override" || "$dev" == *-* ]]   || {
    warn "'$dev' has no hyphen, so there is nothing to derive the jump host from."
    warn "Give the full name (e.g. ffm1-oob-leaf3) or set one explicitly with -j."
    return 1
  }
  return 0
}

# Asks for a device name until a valid one is given. Echoes it.
prompt_device() {
  local jump_override="${1:-}" dev=""
  while true; do
    read -rp "Device name (e.g. ffm1-oob-leaf3): " dev \
      || die "No device name given (input ended). Pass it as an argument instead."
    dev="${dev//[[:space:]]/}"
    valid_device "$dev" "$jump_override" && { printf '%s\n' "$dev"; return 0; }
  done
}

# Jump host = everything before the first hyphen (ffm1-oob-leaf3 -> ffm1).
jump_for() {
  local dev="$1" jump_override="${2:-}"
  printf '%s\n' "${jump_override:-${dev%%-*}}"
}

# ---------- The two hops ----------

# Builds the command string that the JUMP HOST will run. Every argument is
# escaped with %q, so the device name, key path and remote command cannot be
# re-split into multiple words or interpreted by the jump host's shell.
# $1=device  $2=optional command to run on the device
build_remote_ssh() {
  local dev="$1" cmd="${2:-}" out
  out="$(printf 'ssh -i %q %q@%q' "$SSH_KEY" "$SSH_USER" "$dev")"
  [[ -n "$cmd" ]] && out+=" $(printf '%q' "$cmd")"
  printf '%s\n' "$out"
}

# The same string, quoted for a human to paste into a shell.
printable_ssh() {
  local jump="$1" remote="$2"
  printf "ssh -t %s -- '%s'\n" "$jump" "${remote//\'/\'\\\'\'}"
}
