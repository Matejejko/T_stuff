# device-access

Two-hop SSH into lab network devices, in one step.

Devices are not reachable directly — you first log into the site's jump host
and only from there into the device itself, with an explicit SSH key. By hand
that is two commands:

```sh
ssh ffm1
ssh -i ./.ssh/mykey myuser@ffm1-oob-leaf3
```

`connect.sh` collapses that into one: it asks only for the full device name
and derives the jump host itself as the part before the first hyphen
(`ffm1-oob-leaf3` → `ffm1`).

## Run it

```sh
./connect.sh                      # prompts for the device name
./connect.sh ffm1-oob-leaf3       # or pass it directly
./connect.sh -n ffm2-oob-spine2   # print the command only, don't connect
./connect.sh -c 'show version' ffm1-oob-leaf3
```

The **first run** asks for two more things — the login used on the devices and
the SSH key path — and stores them in

```
~/.config/device-access/config
```

From then on the script only ever asks for the device name. Nothing personal
is hardcoded in the script, and the config lives outside the repo, so there is
nothing to gitignore.

## Options

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
and leaves the stored defaults alone.

The config path itself can be moved with `DEVICE_ACCESS_CONFIG=/path/to/file`.

## When something breaks

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

## Notes

- The key path is resolved **on the jump host**, not locally. That is why a
  relative `./.ssh/mykey` is the natural value — exactly what you type by hand
  after logging in. When passing `-i` on the command line, quote it
  (`-i '~/.ssh/mykey'`), otherwise your local shell expands `~` to your local
  home before the script ever sees it.
- Logging into the jump host is left to your local `~/.ssh/config`
  (`ssh ffm1`); the script does not touch it.
- The device name is validated as an RFC 1123 host label and must contain a
  hyphen, otherwise there is no jump host to derive (use `-j` to bypass).
- The remote command is assembled with `printf %q`, so the device name and key
  path cannot be re-split or interpreted by the jump host's shell. The config
  file is parsed line by line and never sourced, so a stray line in it cannot
  execute anything.
