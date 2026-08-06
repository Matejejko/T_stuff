#!/usr/bin/env bash
#
# collect.sh — pull inventory data off SONiC devices over the same two hops.
#
# For each device it logs in exactly like connect.sh does, switches to the
# admin account and runs, non-interactively:
#
#   sonic-cli -c "show platform syseeprom"
#   sonic-cli -c "show platform firmware status"   (falls back to
#                "show platform firmware" if that form is not supported)
#   cat /mnt/onie-boot/onie/update/update.log      (only if needed, see below)
#
# and reports:
#
#   * identity from the syseeprom table (platform, product name, serial, ...)
#   * the ONIE firmware version — taken from a syseeprom field naming both
#     ONIE and firmware if the box has one; otherwise from the last
#     "Firmware update version:" line of the ONIE update log, together with
#     the .bin image that line refers to
#   * every firmware component with its version, nothing else from that table
#
# Everything is one non-interactive run per device: the whole remote side is
# a small shell script, base64-encoded so it survives the local -> jump ->
# device quoting layers untouched, and decoded on the device.
#
# Output is a plain report by default, or JSON with --json for feeding
# something else later.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh" || { printf '[ERROR] common.sh not found next to %s\n' "$SCRIPT_NAME" >&2; exit 1; }

FLAG_USER=""
FLAG_KEY=""
JUMP_HOST=""
ADMIN_USER="admin"    # account switched to on the device (sudo su - admin)
DRY_RUN=0
RECONFIGURE=0
SAVE=0
FORMAT="text"         # text | json
RAW=0                 # print the untouched remote output instead of parsing
PARSE_FILE=""         # parse a saved capture instead of connecting
SAVE_RAW_DIR=""       # also keep each device's raw capture here
LAST_PARSE_OK=1       # set by report_device: did anything parse at all

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options] [device ...]

  device               full device name, e.g. ffm1-oob-leaf3
                       (more than one may be given; if none, you are prompted)

Options:
  -u, --user USER      login on the device, just for this run
  -i, --key PATH       SSH key, path as seen ON THE JUMP HOST, just for this run
      --save           store the -u / -i values as the new defaults
  -R, --reconfigure    ask for login and key again and store them
  -j, --jump HOST      explicit jump host instead of deriving it
  -a, --admin USER     account to switch to on the device (default: $ADMIN_USER)
      --json           JSON output instead of the plain report
      --raw            print the raw remote output, parse nothing
      --save-raw DIR   also write each device's raw output to DIR/<device>.txt
      --parse-file F   parse a previously saved raw capture, no connection
  -n, --dry-run        print the ssh command that would run, then stop
  -h, --help           this help

Login and key come from the same config as connect.sh
($CONFIG_FILE) and are asked for once.

Examples:
  $SCRIPT_NAME ffm1-oob-leaf3
  $SCRIPT_NAME --json ffm1-oob-leaf3 ffm2-oob-spine2 > inventory.json
  $SCRIPT_NAME --save-raw ./captures ffm1-oob-leaf3
  $SCRIPT_NAME --parse-file testdata/sample-capture.txt
EOF
}

# ---------- Argument parsing ----------

DEVICES=()
while (( $# > 0 )); do
  case "$1" in
    -u|--user)        [[ -n "${2:-}" ]] || die "Option $1 requires a value."; FLAG_USER="$2";     shift 2 ;;
    -i|--key)         [[ -n "${2:-}" ]] || die "Option $1 requires a value."; FLAG_KEY="$2";      shift 2 ;;
    -j|--jump)        [[ -n "${2:-}" ]] || die "Option $1 requires a value."; JUMP_HOST="$2";     shift 2 ;;
    -a|--admin)       [[ -n "${2:-}" ]] || die "Option $1 requires a value."; ADMIN_USER="$2";    shift 2 ;;
    --save-raw)       [[ -n "${2:-}" ]] || die "Option $1 requires a value."; SAVE_RAW_DIR="$2";  shift 2 ;;
    --parse-file)     [[ -n "${2:-}" ]] || die "Option $1 requires a value."; PARSE_FILE="$2";    shift 2 ;;
    --json)           FORMAT="json"; shift ;;
    --raw)            RAW=1; shift ;;
    --save)           SAVE=1; shift ;;
    -R|--reconfigure) RECONFIGURE=1; shift ;;
    -n|--dry-run)     DRY_RUN=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    --)               shift; while (( $# > 0 )); do DEVICES+=("$1"); shift; done ;;
    -*)               die "Unknown option: $1 (see $SCRIPT_NAME -h)" ;;
    *)                DEVICES+=("$1"); shift ;;
  esac
done

[[ -n "$SAVE_RAW_DIR" ]] && { mkdir -p "$SAVE_RAW_DIR" || die "Cannot create $SAVE_RAW_DIR"; }

# ---------- The remote side ----------

# Runs on the device as the login user. Sections are delimited by markers so
# that anything the login banner, sudo or ssh itself prints around them cannot
# confuse the parser. stderr is folded into each section on purpose: an error
# from sonic-cli is data worth seeing, not something to hide.
remote_payload() {
  cat <<REMOTE_EOF
set -u
ADMIN=$(printf '%q' "$ADMIN_USER")
LOG=/mnt/onie-boot/onie/update/update.log

mark() { printf '\n===DEVACC:%s===\n' "\$1"; }

# sonic-cli through the admin account, output piped through cat so the CLI
# sees a non-tty stdout and does not paginate.
cli() {
  c="\$1"
  if [ "\$(id -un 2>/dev/null)" = "\$ADMIN" ]; then
    { sonic-cli -c "\$c" 2>&1; } | cat
    return 0
  fi
  out="\$(sudo su - "\$ADMIN" -c "sonic-cli -c \\"\$c\\" | cat" 2>&1)"
  case "\$out" in
    *"not in the sudoers"*|*"Sorry, user"*|*"command not found"*|*"su: "*|"")
      # no sudo, or no sonic-cli inside that account — try it directly
      out="\$( { sonic-cli -c "\$c" 2>&1; } | cat )" ;;
  esac
  printf '%s\n' "\$out"
}

mark HOST
hostname 2>&1

mark SYSEEPROM
cli "show platform syseeprom"

mark FIRMWARE
fw="\$(cli "show platform firmware status")"
case "\$fw" in
  *Component*) ;;
  *) fw="\$(cli "show platform firmware")" ;;
esac
printf '%s\n' "\$fw"

mark UPDATELOG
if [ -r "\$LOG" ]; then
  cat "\$LOG" 2>&1
elif [ -d /mnt/onie-boot/onie ]; then
  sudo cat "\$LOG" 2>&1
else
  echo "__DEVACC_NOTE__ /mnt/onie-boot is not mounted (ONIE partition), update log unavailable"
fi

mark END
REMOTE_EOF
}

# base64 without line wrapping, portable between GNU and BSD/macOS base64.
b64() { base64 | tr -d '\n\r'; }

# ---------- Parsing ----------

# Everything below reads one captured device output on stdin.

section() {
  awk -v want="$1" '
    /^===DEVACC:[A-Z]+===$/ {
      sec = $0; sub(/^===DEVACC:/, "", sec); sub(/===$/, "", sec); next
    }
    sec == want { print }
  '
}

# "Attribute   :Value" -> "Attribute<TAB>Value". Splits on the FIRST colon
# only, so MAC addresses and Vendor Ext bytes survive intact.
eeprom_kv() {
  awk '
    { line = $0; sub(/\r$/, "", line)
      p = index(line, ":"); if (p == 0) next
      k = substr(line, 1, p - 1); v = substr(line, p + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", k); gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (k == "" || k ~ /^-+$/) next
      print k "\t" v }
  '
}

# $1=field name (case-insensitive, exact), reads kv lines on stdin
kv_get() {
  awk -v want="$1" -F'\t' '
    tolower($1) == tolower(want) { print $2; exit }
  '
}

# A syseeprom field that names both ONIE and firmware, e.g.
# "ONIE Firmware Version". Deliberately NOT the plain "Onie Version" field —
# that is the running ONIE, not the firmware updater bundle.
kv_onie_fw() {
  awk -F'\t' '
    { k = tolower($1) }
    k ~ /onie/ && k ~ /(firmware|fw)/ && k ~ /(version|ver)/ { print $2; exit }
  '
}

# The firmware table is fixed-width, so columns are cut at the offsets taken
# from the header line. That is what keeps "Secondary CPLD 1" in one piece.
firmware_table() {
  awk '
    !started && index($0, "Component") && index($0, "Version") {
      c = index($0, "Component"); v = index($0, "Version"); d = index($0, "Description")
      if (d == 0) d = 100000
      started = 1; next
    }
    started {
      line = $0; sub(/\r$/, "", line)
      if (line ~ /^[- \t]*$/) next
      if (length(line) < c) next
      comp = substr(line, c, v - c)
      ver  = substr(line, v, d - v)
      gsub(/^[ \t]+|[ \t]+$/, "", comp); gsub(/^[ \t]+|[ \t]+$/, "", ver)
      if (comp == "" || ver == "") next
      print comp "\t" ver
    }
  '
}

# Last "Firmware update version:" line wins — the log is append-only, so the
# last one is what is on the box now.
log_fw_version() {
  awk '
    /Firmware update version:/ {
      line = $0; sub(/\r$/, "", line)
      sub(/.*Firmware update version:[ \t]*/, "", line)
      sub(/[ \t]+$/, "", line)
      v = line
    }
    END { if (v != "") print v }
  '
}

# ... and the image that update came from (…3.40.5.1-26.bin).
log_fw_image() {
  awk '
    /Firmware update URL:/ {
      line = $0; sub(/\r$/, "", line)
      sub(/.*Firmware update URL:[ \t]*/, "", line)
      sub(/[ \t]+$/, "", line)
      n = split(line, parts, "/")
      cand = parts[n]
      if (cand ~ /\.bin$/) img = cand
    }
    END { if (img != "") print img }
  '
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"; s="${s//$'\r'/}"; s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# ---------- Report for one device ----------

# $1=device  $2=file holding that device's raw capture
report_device() {
  local dev="$1" capture="$2"
  local eeprom fw_rows log_ver log_img onie_fw onie_fw_src
  local platform product serial onie_ver

  eeprom="$(section SYSEEPROM < "$capture" | eeprom_kv)"
  fw_rows="$(section FIRMWARE  < "$capture" | firmware_table)"
  log_ver="$(section UPDATELOG < "$capture" | log_fw_version)"
  log_img="$(section UPDATELOG < "$capture" | log_fw_image)"

  platform="$(kv_get 'Platform'      <<<"$eeprom")"
  product="$( kv_get 'Product Name'  <<<"$eeprom")"
  serial="$(  kv_get 'Serial Number' <<<"$eeprom")"
  onie_ver="$(kv_get 'Onie Version'  <<<"$eeprom")"

  onie_fw="$(kv_onie_fw <<<"$eeprom")"
  if [[ -n "$onie_fw" ]]; then
    onie_fw_src="syseeprom"
  elif [[ -n "$log_ver" ]]; then
    onie_fw="$log_ver"; onie_fw_src="update.log"
  else
    onie_fw=""; onie_fw_src="not found"
  fi

  # Nothing recognisable came back — the caller turns this into a non-zero
  # exit so a scripted run does not silently look successful.
  if [[ -z "$product" && -z "$fw_rows" && -z "$onie_fw" ]]; then
    LAST_PARSE_OK=0
  else
    LAST_PARSE_OK=1
  fi

  if [[ "$FORMAT" == json ]]; then
    printf '  {\n'
    printf '    "device": "%s",\n'          "$(json_escape "$dev")"
    printf '    "platform": "%s",\n'        "$(json_escape "$platform")"
    printf '    "product_name": "%s",\n'    "$(json_escape "$product")"
    printf '    "serial_number": "%s",\n'   "$(json_escape "$serial")"
    printf '    "onie_version": "%s",\n'    "$(json_escape "$onie_ver")"
    printf '    "onie_fw_version": "%s",\n' "$(json_escape "$onie_fw")"
    printf '    "onie_fw_source": "%s",\n'  "$(json_escape "$onie_fw_src")"
    printf '    "onie_fw_image": "%s",\n'   "$(json_escape "$log_img")"
    printf '    "firmware": [\n'
    local first=1 comp ver
    while IFS=$'\t' read -r comp ver; do
      [[ -z "$comp" ]] && continue
      (( first )) || printf ',\n'
      printf '      { "component": "%s", "version": "%s" }' \
        "$(json_escape "$comp")" "$(json_escape "$ver")"
      first=0
    done <<<"$fw_rows"
    (( first )) || printf '\n'
    printf '    ]\n'
    printf '  }'
    return 0
  fi

  printf '=== %s ===\n' "$dev"
  printf '  Platform         : %s\n' "${platform:-?}"
  printf '  Product name     : %s\n' "${product:-?}"
  printf '  Serial number    : %s\n' "${serial:-?}"
  printf '  ONIE version     : %s\n' "${onie_ver:-?}"
  if [[ -n "$onie_fw" ]]; then
    printf '  ONIE FW version  : %s   (from %s)\n' "$onie_fw" "$onie_fw_src"
  else
    printf '  ONIE FW version  : NOT FOUND (no matching syseeprom field and no update log)\n'
  fi
  # Only worth showing next to a version that actually came from that log.
  [[ -n "$log_img" && "$onie_fw_src" == "update.log" ]] \
    && printf '  ONIE FW image    : %s\n' "$log_img"
  printf '\n'
  if [[ -n "$fw_rows" ]]; then
    printf '  %-22s %s\n' "Component" "Version"
    printf '  %-22s %s\n' "----------------------" "--------------"
    local comp ver
    while IFS=$'\t' read -r comp ver; do
      [[ -z "$comp" ]] && continue
      printf '  %-22s %s\n' "$comp" "$ver"
    done <<<"$fw_rows"
  else
    printf '  Firmware table   : NOT PARSED (see --raw for what the device sent)\n'
  fi
  printf '\n'
}

# ---------- Offline mode ----------

if [[ -n "$PARSE_FILE" ]]; then
  [[ -r "$PARSE_FILE" ]] || die "Cannot read $PARSE_FILE"
  DEV_NAME="${DEVICES[0]:-$(section HOST < "$PARSE_FILE" | tr -d '\r' | awk 'NF{print;exit}')}"
  [[ -n "$DEV_NAME" ]] || DEV_NAME="$(basename "$PARSE_FILE")"
  if (( RAW )); then cat "$PARSE_FILE"; exit 0; fi
  [[ "$FORMAT" == json ]] && printf '[\n'
  report_device "$DEV_NAME" "$PARSE_FILE"
  [[ "$FORMAT" == json ]] && printf '\n]\n'
  (( LAST_PARSE_OK )) || exit 1
  exit 0
fi

# ---------- Live collection ----------

command -v ssh >/dev/null 2>&1 || die "ssh is not in PATH."
command -v base64 >/dev/null 2>&1 || die "base64 is not in PATH."

resolve_credentials "$FLAG_USER" "$FLAG_KEY" "$RECONFIGURE" "$SAVE"

if (( ${#DEVICES[@]} == 0 )); then
  DEVICES+=("$(prompt_device "$JUMP_HOST")")
fi

PAYLOAD_B64="$(remote_payload | b64)"
DEVICE_CMD="printf %s '$PAYLOAD_B64' | base64 -d | sh"

TMPDIR_RUN="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_RUN"' EXIT

FAILED=0
FIRST_JSON=1
[[ "$FORMAT" == json ]] && (( ! RAW )) && printf '[\n'

for DEVICE in "${DEVICES[@]}"; do
  if ! valid_device "$DEVICE" "$JUMP_HOST"; then FAILED=1; continue; fi
  JUMP="$(jump_for "$DEVICE" "$JUMP_HOST")"
  REMOTE_SSH="$(build_remote_ssh "$DEVICE" "$DEVICE_CMD")"

  if (( DRY_RUN )); then
    info "Device $DEVICE via $JUMP — command that would run:"
    printable_ssh "$JUMP" "$REMOTE_SSH"
    continue
  fi

  info "Collecting from $DEVICE via $JUMP ..."
  CAPTURE="$TMPDIR_RUN/$DEVICE.txt"
  RC=0
  # -t so sudo can prompt for a password if the account needs one; the pty
  # turns line endings into CRLF, which the parsers strip.
  ssh -t "$JUMP" -- "$REMOTE_SSH" > "$CAPTURE" 2>"$TMPDIR_RUN/$DEVICE.err" || RC=$?
  tr -d '\r' < "$CAPTURE" > "$CAPTURE.clean" && mv "$CAPTURE.clean" "$CAPTURE"

  if [[ -n "$SAVE_RAW_DIR" ]]; then
    cp "$CAPTURE" "$SAVE_RAW_DIR/$DEVICE.txt"
    info "Raw output saved to $SAVE_RAW_DIR/$DEVICE.txt"
  fi

  if ! grep -q '^===DEVACC:END===' "$CAPTURE"; then
    warn "$DEVICE: the remote script did not finish (ssh exit $RC)."
    [[ -s "$TMPDIR_RUN/$DEVICE.err" ]] && sed 's/^/          /' "$TMPDIR_RUN/$DEVICE.err" >&2
    warn "Run again with --raw to see exactly what came back."
    FAILED=1
    continue
  fi

  if (( RAW )); then
    printf '########## %s ##########\n' "$DEVICE"
    cat "$CAPTURE"
    continue
  fi

  if [[ "$FORMAT" == json ]]; then
    (( FIRST_JSON )) || printf ',\n'
    FIRST_JSON=0
  fi
  report_device "$DEVICE" "$CAPTURE"
  (( LAST_PARSE_OK )) || { warn "$DEVICE: connected, but none of the expected output was found."; FAILED=1; }
done

if [[ "$FORMAT" == json ]] && (( ! RAW )); then
  (( FIRST_JSON )) || printf '\n'
  printf ']\n'
fi

exit "$FAILED"
