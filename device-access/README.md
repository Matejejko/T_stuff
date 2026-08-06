# device-access

Two-hop SSH into lab network devices, in one step.

Devices are not reachable directly — you first log into the site's jump host
and only from there into the device itself, with an explicit SSH key. By hand
that is two commands:

```sh
ssh ffm1
ssh -i ./.ssh/OpenCloud mpapaj@ffm1-oob-leaf3
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

| Option | Meaning | Default |
|---|---|---|
| `-u, --user` | login on the device | `mpapaj` |
| `-i, --key` | SSH key, path as seen **on the jump host** | `./.ssh/OpenCloud` |
| `-j, --jump` | explicit jump host instead of deriving it | part before the first hyphen |
| `-c, --command` | run a command on the device and exit | — |
| `-n, --dry-run` | print the command, don't run it | — |
| `-h, --help` | help | — |

The default login and key can also be set through the `DEVICE_SSH_USER` and
`DEVICE_SSH_KEY` environment variables.

## Notes

- The key path is resolved **on the jump host**, not locally. That is why the
  default is the relative `./.ssh/OpenCloud` — exactly what you type by hand
  after logging in.
- Logging into the jump host is left to your local `~/.ssh/config`
  (`ssh ffm1`); the script does not touch it.
- The device name is validated as an RFC 1123 host label and must contain a
  hyphen, otherwise there is no jump host to derive (use `-j` to bypass).
- The remote command is assembled with `printf %q`, so the device name and key
  path cannot be re-split or interpreted by the jump host's shell.
