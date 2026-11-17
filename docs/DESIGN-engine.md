# Design note: the command-line engine

Version 1, 2026-11-15. Status: agreed by the owner on 2026-11-15, including all eight
decisions in section 12. Nothing here is built yet.

The **engine** is the one program that mounts and dismounts volumes. The web pages, the
Dashboard tile and the event hooks all call it and contain no mount logic of their own
(CLI-1). This note covers what step 4 needs (mount and dismount one volume) and shows
where the later parts plug in.

Points marked **Decision** need a yes or no from the owner. Points marked **To test** are
assumptions that a small test on a throwaway volume must confirm before we rely on them.

## 1. Language: PHP

**Decision D1.** Write the engine in PHP rather than as a shell script.

- PHP ships with Unraid and the web pages are PHP anyway, so there is one language.
- PHP can start a program with a list of arguments and no shell in between. User input
  then cannot be misread as a command, which is what SEC-3 asks for. In a shell script
  this depends on getting the quoting right every single time.
- Reading the configuration and printing machine-readable output is built in.

The price: the engine is a little longer than a shell script would be.

## 2. Name and location

**Decision D2.** The command is called `vcmount`.

- The file lives in the plugin folder: `/usr/local/emhttp/plugins/veracrypt.mount/scripts/vcmount`.
- The package also places a link at `/usr/local/sbin/vcmount`, so typing `vcmount` in an
  SSH session works (CLI-3).

**Decision D3.** Confirm the plugin ID `veracrypt.mount` (it appears in every path below
and is hard to change later).

## 3. Commands

| Command | What it does |
| --- | --- |
| `vcmount list` | Lists the saved volumes and anything currently mounted. |
| `vcmount status <name>` | Shows one volume: locked, unlocked or mounted, and where. |
| `vcmount mount <name>` | Unlocks and mounts a saved volume. |
| `vcmount mount --file <path> --name <name> [options]` | Mount without saving (VOL-5). |
| `vcmount dismount <name>` | Stops the dependents, then dismounts and locks one volume. Not forced unless `--force` is given. |
| `vcmount dismount --all` | The same for every mounted volume. Used by the `unmounting_disks` hook. |
| `vcmount stop-dependents --all` | Stops the dependents of every mounted volume; the volumes stay mounted. Used by the `stopping_docker` hook. |
| `vcmount start-dependents --all` | Starts the dependents of every mounted volume in list order. Used by the `docker_started` hook after Docker was switched off and on (LIFE-4). |
| `vcmount repair-shares` | Makes the SMB shares match the mounted volumes: adds missing ones, removes left-over ones (section 9b). |
| `vcmount options` | Lists the Unraid users and the Docker containers, for the web forms. Changes nothing. |
| `vcmount config` | Shows the saved settings as stored, with their revision (a SHA-256 fingerprint of the file, or `none`). Changes nothing. |
| `vcmount save-config [--revision <r>]` | Reads new settings as JSON on standard input, checks them with the same rules used when reading the file, and replaces the file in one step (Decision U1 in `docs/DESIGN-ui.md`). With `--revision` it refuses (code 3) when the file changed since it was read, so a change made in another browser tab is not overwritten unseen. It always refuses to rename or remove a volume that is mounted (decision D3, 2026-11-16). |
| `vcmount busy` | Says whether another `vcmount` action is running. The web page uses it after a lost answer. |

`vcmount mount ... --over-http` is what the web page sends when the password came over
plain HTTP. It is refused (code 3) while the setting `require_https` is on (UI-5).
`vcmount list --json` also returns the plugin's settings.

Options for an unsaved mount: `--read-only`, `--hidden`, `--keyfile <path>` (repeatable).
For a saved volume these come from the configuration.

Every command accepts `--json`, which prints the result in a machine-readable form (JSON)
for the web pages. Without it the output is plain text for people.

Dependents and the forced dismount are in section 9a, shares in section 9b.

**Result codes.** Each run ends with a number that tells the caller what happened:

| Code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | Wrong usage or a fault in the configuration. |
| 2 | The volume could not be unlocked (wrong password, PIM or keyfile). |
| 3 | Refused by a safety check (see section 7). Nothing was changed. |
| 4 | The filesystem could not be mounted (dirty, or not NTFS/exFAT). The volume was locked again. |
| 5 | Dismount aborted because the volume is busy. It stays mounted. |
| 6 | Another `vcmount` action is still running. |
| 7 | The volume is mounted, but a dependent could not be started. |
| 8 | The volume is mounted, but its SMB share could not be added. |

## 4. How secrets travel

The engine **never reads the password itself**. It starts `cryptsetup` and lets it read
directly from the engine's own standard input:

- Typed over SSH: `cryptsetup` asks for the password on the terminal, without showing it.
- From the web page: the page starts `vcmount` (without a shell) and writes the password
  into its standard input. It goes straight through to `cryptsetup`.

So the password is never in a command line, an environment variable, a file or the
engine's memory (SEC-1). This is the method that worked in test 1.

- **Keyfiles:** only the *path* is handed to `cryptsetup` as an argument; `cryptsetup`
  reads the file itself. The path of a saved volume is not a secret (KEY-3). For an
  unsaved mount the path is briefly visible in the server's process list to anyone with
  root. I think that is acceptable, since root can see the mount anyway.
- **PIM:** `cryptsetup` can either take the PIM as an argument (not allowed by SEC-1) or
  ask for it after the password. **To test:** that the second way works through
  standard input (this is deferred test 4). Until then the engine supports password and
  keyfiles only, which covers the real volumes.

**No added waiting time after a wrong password** (decided 2026-11-15; SEC-5 dropped).
The engine adds no delay of its own. Each attempt still takes as long as `cryptsetup`
needs to check a password, which VeraCrypt makes slow on purpose; that is the real
protection against guessing.

## 5. Configuration

**Decision D4.** One file on the flash drive:
`/boot/config/plugins/veracrypt.mount/volumes.json`. This is where Unraid plugins keep
their settings so they survive a reboot.

- Format JSON (a common plain-text format), because a volume has an *ordered list* of
  dependents, which Unraid's simpler settings format cannot express well.
- Per volume: name, display name, path of the volume file, mount location, read-only,
  hidden, key source (ask / keyfile paths), and later share settings and dependents.
- **No secrets, ever** (KEY-5, SEC-4).
- The file is written **only when the user saves settings** in the web page. Mounting and
  dismounting never write to the flash drive.
- A volume **name** may contain only letters, digits, `-` and `_`, at most 32 characters.
  The name is used for the mount point and later for the share name.

## 6. State comes from the live system

The engine keeps no "what is mounted" file (LIFE-7). It asks the system each time:

- An unlocked volume shows up as a device named `/dev/mapper/vcm-<name>`. The prefix
  `vcm-` marks it as ours; the engine never touches a device without it.
- The system's mount table (`/proc/mounts`) shows whether and where that device is mounted.

A volume is therefore in one of three states: **locked**, **unlocked** (device exists,
not mounted; only seen after a failure) or **mounted**. This stays correct after a crash
or a plugin update, and it also shows unsaved volumes without storing anything.

## 7. Mount, step by step

1. Take the lock (section 9).
2. Check the name. Resolve the path of the volume file and check it is an ordinary file.
3. Safety checks; refuse with code 3 if any fails:
   - the volume is already unlocked or mounted;
   - the volume file is already in use as a device on the server;
   - the mount point exists and is not an empty folder;
   - **(VOL-7, Decision D5)** a network client has the volume file open right now,
     according to Samba's own list of open files. This guards against mounting on Bob
     and on Windows at the same time.
4. Unlock: `cryptsetup tcryptOpen --veracrypt <file> vcm-<name>`, plus `--readonly`,
   `--tcrypt-hidden` and `--key-file` as configured. Wrong password: stop with code 2.
5. Ask the system which filesystem is inside. If it is neither NTFS nor exFAT: lock
   again, stop with code 4.
6. Create the mount point and mount it with the options in section 8. If that fails
   (for example the volume is dirty): remove the mount point, lock again, stop with
   code 4 and explain the repair (FS-5). The engine never uses the "force" option.
7. Write one log line, add the share (section 9b), start the dependents (section 9a).

Whatever goes wrong, the engine undoes its own steps, so a failed mount leaves the
volume locked.

## 8. Mount options

- NTFS: kernel driver `ntfs3` (worked in test 1). exFAT: kernel driver `exfat`
  (**To test**, deferred test 2).
- Always: `nosuid,nodev` (programs inside the volume get no special rights) and
  `uid=99,gid=100` (files appear owned by `nobody:users`, the Unraid convention). **(FS-4)**
- Read-only volumes: additionally `ro`, and `cryptsetup` opens them read-only too.
- **Decision D6 (FS-3).** `windows_names` on by default for NTFS: refuses file names that
  Windows cannot handle. **To test** that Unraid's `ntfs3` accepts the option.

**Decision D7, ownership (finding from test 1).** Files created on Bob keep the Linux
owner of whoever created them; only files created on Windows appear as `nobody:users`.
My proposal: accept this for version 1 and do not try to rewrite ownership.

- Files written over the network share will be made to belong to `nobody` by the share
  settings (as Unraid's own shares do), so normal use is unaffected.
- A container that writes as another user leaves files owned by that user, the same as
  on any Unraid share.
- We look at it again when sharing is built, with a practical test.

## 9. Dismount, step by step

1. Take the lock.
2. Remove the share (section 9b), so network clients let go, then stop the dependents
   (section 9a).
3. Dismount, plainly. Never "lazy", and not forced unless asked (LIFE-5).
4. If the volume is busy: list which programs and which network clients hold it open,
   stop with code 5. The volume stays mounted and usable. With `--force`, see 9a.
5. Remove the empty mount point, then lock: `cryptsetup close vcm-<name>`.
6. Write one log line.

Dismount works from any state, so a volume left **unlocked** after a failure can be
locked with the same command.

## 9a. Dependents and the forced dismount (added 2026-11-15)

**Configuration.** A saved volume has an ordered list `dependents`. Each entry has
`container` (the name of the Docker container), `grace` (seconds it gets to stop by
itself, default 60) and `delay` (seconds to wait after starting it, default 0). Compose
stacks come later.

**On mount (DOC-3).** After the volume is mounted, the dependents are started in list
order. One that fails does not hold back the others; the volume stays mounted and the
result is code 7.

**On dismount (DOC-4, DOC-5).** Before the volume is dismounted, the dependents are
stopped in reverse order with `docker stop` and their grace period. Docker kills a
container that has not stopped by then. The engine reports and logs each kill.

**Forced dismount (LIFE-5).** Only with `--force`, and only after the plain dismount
has failed:

1. Programs on the server that hold the volume open get the stop signal and 10 seconds,
   then are killed. The plain dismount is tried again.
2. If the volume then cannot be locked because a container that is not a dependent
   still has a folder of it, that container is stopped with `docker stop` (10 seconds,
   then killed) and locking is tried again.

**At array stop (LIFE-1, LIFE-10).** Two hooks call the engine. `stopping_docker` runs
`vcmount stop-dependents --all` and takes at most half of Unraid's shutdown time-out.
`unmounting_disks` runs `vcmount dismount --all --array-stop` and takes at most a
quarter. With `--array-stop` the dismount is forced unless the configuration file says
`"settings": {"force_at_array_stop": false}`.

**Notifications (LIFE-9).** Faults go to Unraid's notifications as well as the system
log, with the same text: a dependent that could not be started or stopped or was
killed, an aborted dismount, a forced dismount. Never for a volume that is not saved.
Not built yet: notifications for failed mounts; they come with automount.

The engine refuses to force when the command itself was started from inside the volume.
A "lazy" dismount is never used. Network clients are disconnected by removing the
share (section 9b). **To test** (part 4 of the Docker step): all of this section on a throwaway
volume and a throwaway container.

## 9b. SMB shares (added 2026-11-16)

**Configuration (SHR-1, SHR-2).** A saved volume may have a `share` entry:

```json
"share": { "export": "yes", "users": { "alice": "read-write", "guest-user": "read-only" } }
```

No `share` entry means no share. The share is named after the volume (`\\Bob\<name>`).
It works like Unraid's own "Private" share security (decided 2026-11-16): only the users
listed may connect, each `read-write` or `read-only`; at least one is required. Guests
never get access, so Unraid's "Public" and "Secure" levels are not offered: they would
let anyone on the network read the decrypted data. `export` is `yes` or `hidden` (hidden
from network browsing), as Unraid's "Export: Yes / Yes (hidden)". A volume that is
mounted read-only gives nobody write access. An unsaved volume (VOL-5) is never shared.

**How (SHR-3).** Unraid's own `/etc/samba/smb.conf` includes
`/etc/samba/smb-unassigned.conf`, which belongs to Unassigned Devices. The engine keeps
one file per share in `/etc/samba/veracrypt-shares/<name>.conf` and adds one line
`include = <that file>` to `smb-unassigned.conf`. Unassigned Devices keeps such lines as
long as the file exists (spec, test 10). Everything is in RAM; a reboot clears it, and
the share is added again when the volume is mounted.

**The share file.** `path` is the mount location; `valid users` all listed users;
`read only = yes` with `write list` naming the read-write users (left out when the
volume is mounted read-only); `browseable = no` when hidden; `guest ok = no`. Files are
written as `nobody:users` (`force user = nobody`, `force group = users`), as Unraid's
own shares do. That is also needed to write at all: the volume's files appear as owned
by `nobody` with no write right for other users. The file ends with `[global]`, as
Unassigned Devices does.

**Adding (after mounting).** Checks first: SMB is turned on in Unraid, every user exists,
and no other share has the same name (Samba ignores upper and lower case; the list comes
from `testparm -s`). Then write the file, add the include line, run
`smbcontrol all reload-config`. If a check fails the volume stays mounted, nothing is
written, and the result is code 8.

**Removing (before dismounting).** Delete the file, remove the include line, reload,
then `smbcontrol all close-share <name>`, which disconnects clients that are still
connected. A share that cannot be removed cleanly is logged; the dismount goes on.

**Writing `smb-unassigned.conf`.** The engine reads it, adds or removes only its own
line, writes the result to a temporary file next to it and renames that over the
original, so the file is never half written. Unassigned Devices takes no lock, so if
both write in the same instant one change can be lost; `vcmount repair-shares` puts
things right and the web page can call it when it loads.

**Open files (VOL-7).** Before unlocking, the engine asks Samba for its list of open
files (`smbstatus -L --json`). If the volume file is open from the network, the mount is
refused with code 3. The `/mnt/user/...` and `/mnt/<disk>/...` paths of one file count
as the same file. If Samba is running but cannot be asked, the mount is refused too.

## 10. Safeguards

- **Lock.** Only one `vcmount` action that changes something runs at a time. A second
  one stops at once with code 6 rather than queueing up. `list` and `status` need no lock.
- **Time limits.** Each program the engine starts has a time limit, so the engine cannot
  hang forever. This matters for the event hooks, because Unraid waits for them (test 8).
- **Log.** To Unraid's system log, under the name `veracrypt.mount`. Events only:
  mounted, dismounted, failed, refused, with the volume *name*. Never a password, never
  a file name from inside a volume (PRIV-1). For an unsaved volume the engine logs
  nothing at all (VOL-5, PRIV-2). Limit: the system itself may still note that "a
  device" was mounted; the engine cannot prevent that.
- **No header changes.** The engine only ever calls `cryptsetup` to open, close and show
  status (SEC-7).

## 11. Not in this note

Designed when their step comes: automount with
a keyfile, idle auto-lock, notifications, hidden-volume and PIM details, opening the file
by its disk path (VOL-8).

## 12. Decisions (all agreed 2026-11-15)

| No. | Question | Agreed |
| --- | --- | --- |
| D1 | Language of the engine | PHP |
| D2 | Command name | `vcmount` |
| D3 | Plugin ID | `veracrypt.mount` |
| D4 | Configuration as one JSON file on the flash drive, written only when settings are saved | Yes |
| D5 | VOL-7: refuse to mount while a network client has the volume file open | Yes |
| D6 | FS-3: `windows_names` on by default | Yes, if the test passes |
| D7 | Ownership of files created on Bob | Accept for version 1, revisit with sharing |
| D8 | CLI-1 to CLI-3, LIFE-7 and FS-4 as written in the spec | Confirm |
