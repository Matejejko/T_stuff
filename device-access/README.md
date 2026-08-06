# device-access

Two-hop access to lab network devices.

Devices are not reachable directly — you first log into the site's jump host
and only from there into the device itself, with an explicit SSH key. By hand
that is two commands:

```sh
ssh ffm1
ssh -i ./.ssh/mykey myuser@ffm1-oob-leaf3
```

Both scripts here collapse that into one and derive the jump host themselves
from the device name — the part before the first hyphen
(`ffm1-oob-leaf3` → `ffm1`).

| Script | What it does |
|---|---|
| `connect.sh` | drops you into an interactive session on the device |
| `collect.sh` | logs in, pulls inventory data off the device, prints a report |
| `common.sh` | shared plumbing (config, validation, the two hops) — sourced, not run |

---

## connect.sh

```sh
./connect.sh                      # prompts for the device name
./connect.sh ffm1-oob-leaf3       # or pass it directly
./connect.sh -n ffm2-oob-spine2   # print the command only, don't connect
./connect.sh -c 'show version' ffm1-oob-leaf3
```

The **first run** asks for two more things — the login used on the devices and
the SSH key path — and stores them in `~/.config/device-access/config`. From
then on the scripts only ever ask for the device name. Nothing personal is
hardcoded, and the config lives outside the repo, so there is nothing to
gitignore.

| Option | Meaning |
|---|---|
| `-u, --user USER` | login on the device, for this run only |
| `-i, --key PATH` | SSH key, path as seen **on the jump host**, for this run only |
| `--save` | store the `-u` / `-i` values as the new defaults |
| `-R, --reconfigure` | ask for login and key again and store them |
| `-j, --jump HOST` | explicit jump host instead of deriving it |
| `-c, --command CMD` | run a command on the device and exit |
| `-n, --dry-run` | print the command, don't run it |
| `-h, --help` | help |

Precedence: `-u` / `-i` → `DEVICE_SSH_USER` / `DEVICE_SSH_KEY` → config file.
Only `--save` and `-R` ever write the config; a plain `-u` / `-i` is a one-off
and leaves the stored defaults alone. The config path itself can be moved with
`DEVICE_ACCESS_CONFIG=/path/to/file`.

### When something breaks

If ssh exits 255 — its own failure code, meaning the session never started —
the script says so and offers to fix the login and key on the spot:

```
[WARN] SSH failed. Either the jump host 'ffm1' is unreachable, or the
[WARN] login/key is wrong for 'ffm1-oob-leaf3' (currently myuser, ./.ssh/mykey).
Change login/key and try again? [y/N]:
```

Answer `y` and it re-asks, saves, and retries the same device straight away.
Any other exit code belongs to the remote side and is passed through untouched,
so `-c` keeps working in scripts.

---

## collect.sh

Pulls inventory data off SONiC devices — no typing, one non-interactive run
per device:

```sh
./collect.sh ffm1-oob-leaf3
./collect.sh --json ffm1-oob-leaf3 ffm2-oob-spine2 > inventory.json
```

```
=== ffm1-oob-leaf3 ===
  Platform         : X86_64-dellemc_s5224f_c3538-r0
  Product name     : S5224F-ON
  Serial number    : TH0DCXH8CET002B43G76
  ONIE version     : 3.40.1.1-9
  ONIE FW version  : 3.40.5.1-26   (from update.log)
  ONIE FW image    : onie-update-full-x86_64-dellemc_s5200_c3538-r0.3.40.5.1-26.bin

  Component              Version
  ---------------------- --------------
  BIOS                   3.40.0.9-17
  BMC                    1.08
  FPGA                   2.65
  PCIe                   2.6
  Secondary CPLD 1       1.0
  System CPLD            0.9
```

### What it runs on the device

After the second hop it switches to the admin account and runs, without any
interactive CLI session:

```sh
sudo su - admin -c 'sonic-cli -c "show platform syseeprom" | cat'
sudo su - admin -c 'sonic-cli -c "show platform firmware status" | cat'
cat /mnt/onie-boot/onie/update/update.log      # only when needed, see below
```

Piping through `cat` is deliberate: it gives `sonic-cli` a non-tty stdout so
it does not paginate. If `show platform firmware status` comes back without a
`Component` column, it retries with `show platform firmware`. If the login
account already *is* admin, or `sudo su -` is refused, it falls back to calling
`sonic-cli` directly.

The whole remote side is one small shell script, base64-encoded before it is
sent and decoded on the device — that is what keeps it intact through the
local → jump → device quoting layers. Its output is split into marked sections
(`===DEVACC:SYSEEPROM===` and friends), so login banners, MOTDs or a sudo
prompt around it cannot confuse the parser.

### The ONIE firmware version

This is the one field with a rule rather than a lookup:

1. If the syseeprom table has a field naming **both** ONIE and firmware (e.g.
   `ONIE Firmware Version`), that is used. The plain `Onie Version` field is
   *not* it — that is the running ONIE, reported separately as `ONIE version`.
2. Otherwise the ONIE update log is read and the **last**
   `Firmware update version:` line wins (the log is append-only, so the last
   one is what is on the box). The `.bin` image from the matching
   `Firmware update URL:` line is reported next to it.
3. If neither exists, the report says `NOT FOUND` rather than guessing.

`/mnt/onie-boot` is only mounted on demand on some boxes. If it is not
mounted, the script says so instead of failing — it will **not** mount it for
you, since that changes state on a production switch.

### Options

Everything `connect.sh` takes (`-u`, `-i`, `--save`, `-R`, `-j`, `-n`), plus:

| Option | Meaning |
|---|---|
| `-a, --admin USER` | account to switch to on the device (default `admin`) |
| `--json` | JSON array instead of the plain report |
| `--raw` | print the untouched remote output, parse nothing |
| `--save-raw DIR` | also write each device's raw output to `DIR/<device>.txt` |
| `--parse-file F` | parse a saved capture, no connection at all |

Exit status is non-zero if any device failed to connect, did not finish, or
came back with none of the expected output — so a scripted run cannot silently
look successful.

### Debugging a device that reports oddly

```sh
./collect.sh --save-raw ./captures ffm1-oob-leaf3   # keep what it sent
./collect.sh --parse-file ./captures/ffm1-oob-leaf3.txt
```

`--parse-file` runs the parsers alone, with no SSH involved, which is also how
`testdata/sample-capture.txt` is used as a regression fixture:

```sh
./collect.sh --parse-file testdata/sample-capture.txt
```

---

## Notes

- The key path is resolved **on the jump host**, not locally. That is why a
  relative `./.ssh/mykey` is the natural value — exactly what you type by hand
  after logging in. When passing `-i` on the command line, quote it
  (`-i '~/.ssh/mykey'`), otherwise your local shell expands `~` to your local
  home before the script ever sees it.
- Logging into the jump host is left to your local `~/.ssh/config`
  (`ssh ffm1`); the scripts do not touch it.
- The device name is validated as an RFC 1123 host label and must contain a
  hyphen, otherwise there is no jump host to derive (use `-j` to bypass).
- Remote commands are assembled with `printf %q`, so device names and paths
  cannot be re-split or interpreted by the jump host's shell. The config file
  is parsed line by line and never sourced, so a stray line in it cannot
  execute anything.
- A TTY is requested for both hops (`ssh -t`) so `sudo` can still prompt for a
  password if the account needs one; the CR line endings that come with it are
  stripped before parsing.
