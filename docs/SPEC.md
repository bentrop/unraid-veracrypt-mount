# unraid-veracrypt-mount: Specification

Version 0.1, 2026-11-15. Status: requirements agreed in conversation; no code written yet.

Owner: GitHub `bentrop`. Written for private use first; may be published to
Community Apps later if it turns out well.

Each requirement carries a status:

- **Agreed**: the owner stated it or explicitly accepted it.
- **Proposed**: suggested during planning, not yet explicitly confirmed. Confirm before building.
- **Verify**: depends on a fact that must be tested on the server first (see section 10).

## 1. Purpose

An Unraid plugin that mounts VeraCrypt volumes natively (using the `cryptsetup` that ships
with Unraid, no VeraCrypt binary) and starts and stops user-defined Docker containers
together with those volumes.

Goals, in priority order:

1. Secure: no secret is stored, logged or exposed unless the user explicitly opts in.
2. Safe: volumes are always dismounted cleanly; nothing is ever forced silently.
3. Elegant and convenient: looks Unraid-native, few clicks, sensible defaults.
4. Maintainable: small, readable, one engine behind every interface.

## 2. Terminology

To avoid confusion between the two kinds of "container":

- **Volume**: a VeraCrypt container file (the encrypted file).
- **Container**: a Docker container.
- **Dependent**: a Docker container or Compose stack tied to a volume.
- **Mount / dismount**: unlock a volume and make its contents available / the reverse.

Use these words in code, UI and documentation.

## 3. Environment (checked 2026-11-15)

| Item | Value |
| --- | --- |
| Server | "Bob", Unraid 7.4, kernel 6.18.60-Unraid |
| cryptsetup | 2.8.8, flags include `KERNEL_CAPI` |
| Build tools on server | `/sbin/makepkg`, `/usr/bin/php` |
| NTFS | kernel module `ntfs3` present; `/bin/ntfs-3g` and `/bin/ntfsfix` present |
| exFAT | kernel module `exfat` present; `/sbin/fsck.exfat` present |
| Proven so far | `cryptsetup tcryptDump` read a throwaway volume (PBKDF2-SHA512, AES-XTS) |
| Not yet proven | actual mapping and mounting; anything in section 10 |
| Web UI | plain HTTP on the LAN (no HTTPS yet) |
| Docker | Unraid templates today; migration to Compose stacks planned |
| Dev machine | Windows PC, repo at `G:\dev\unraid-veracrypt-mount` |

Nothing needs to be installed on the server.

## 4. Scope

### In scope for version 1

- VeraCrypt **container files** stored on Unraid shares.
- Standard and hidden volumes; password, PIM and keyfiles.
- Inside the volumes, every file system both VeraCrypt and Unraid support (FS-1),
  mounted read-write; FAT32, exFAT and NTFS stay usable on Windows.
- Several volumes mounted at once.
- Per-volume network share over SMB.
- Docker control for Unraid-template containers and Compose stacks.
- Web UI pages, a Dashboard tile and a command-line tool.

### Out of scope for version 1

- Creating volumes, changing passwords, changing headers. `cryptsetup` cannot write
  VeraCrypt headers; this stays in VeraCrypt on Windows.
- Encrypted partitions, whole disks and USB drives (may come later if simple).
- NFS export (not needed).
- TPM-bound and network-fetched keys (designed for, not built; see KEY-4).
- Moving a container's appdata automatically.

## 5. Functional requirements

### 5.1 Volumes

- **VOL-1 (Agreed)** Multiple volumes can be configured and mounted at the same time,
  in the manner of VeraCrypt's volume list.
- **VOL-2 (Agreed)** Per saved volume: display name, path of the container file, mount
  location, read-only switch, key source, share settings, dependents.
- **VOL-3 (Agreed)** Hidden volumes are supported. A saved volume has a "hidden volume"
  option.
- **VOL-4 (Agreed)** A per-volume **read-only** switch. Reason: `cryptsetup` has no
  hidden-volume protection, so an outer volume mounted read-write can overwrite the
  hidden volume inside it. The UI must explain this next to the switch.
- **VOL-5 (Agreed)** **Mount without saving**: pick a file, enter the credentials, mount.
  Nothing about this volume is written to the configuration or to any log. Accepted
  limits: no Docker rules can be attached, and a running server visibly has it mounted.
- **VOL-6 (Agreed)** "Mount all" and "Dismount all" actions.
- **VOL-7 (Agreed)** Before mounting, refuse if a network client currently has the
  container file open (protects against mounting on Bob and on Windows at once, which
  corrupts the volume).
- **VOL-8 (Verify, measured 2026-11-17)** Open the backing file through its real disk or
  pool path instead of the `/mnt/user` path if that proves faster and safe. On an array
  disk it is not faster (test result in section 10): the disk and parity are the limit,
  not Unraid's share layer. Keep the `/mnt/user` path; look again only for a volume on
  a fast pool (NVMe), where the share layer may matter. A pool path also changes when
  the mover moves the file, so it would need care.

### 5.2 Credentials and key sources

- **KEY-1 (Agreed)** Default key source is **ask every time**. Nothing secret is stored
  on the server.
- **KEY-2 (Agreed)** Password, PIM and one or more keyfiles are supported, in any
  combination VeraCrypt allows.
- **KEY-3 (Agreed)** Optional key source **keyfile at a path**, for example a USB stick.
  Only the path is stored. If the keyfile is present at array start and no password is
  needed, the volume can mount automatically; otherwise it waits for the user.
- **KEY-4 (Agreed)** The design leaves room for further key sources later: a key fetched
  from another device on the network, and a secret sealed to the server's TPM. Each
  must state in plain words what it does and does not protect against.
- **KEY-5 (Agreed)** A password is **never** stored in plain form on the flash drive.
  The flash is FAT32 (no file permissions) and is copied into flash backups, including
  cloud backups through Unraid Connect.
- **KEY-6 (Agreed)** Automount is always an explicit, per-volume opt-in.

### 5.3 Filesystems

- **FS-1 (Agreed, extended 2026-11-17)** Every file system that both VeraCrypt and
  Unraid support, read-write: FAT32 (`vfat`), exFAT, NTFS (`ntfs3`), ext2/3/4 (`ext4`),
  XFS and Btrfs. Not ReFS, HFS+ or APFS (Unraid has no driver) and not ZFS (a pool, not
  one file system to mount). FAT32, exFAT and NTFS have no owners, so their files appear
  as `nobody:users` (FS-4); ext4, XFS and Btrfs keep real owners and permissions, which
  lets containers such as databases run from them, but VeraCrypt on Windows cannot open
  them.
- **FS-2 (Verify)** NTFS driver: start with the kernel driver `ntfs3`; `ntfs-3g` is
  available as a fallback. Decide after testing. A newer kernel driver, called plain
  `ntfs` (formerly NTFSPLUS), comes with a working check-and-repair tool. It is not
  part of Unraid 7.4 (kernel 6.18.60, checked 2026-11-15); look again when Unraid moves
  to a kernel that includes it.
- **FS-3 (Agreed)** Mount with the option that rejects file names Windows cannot
  handle (`windows_names`), on by default. Unraid 7.4's `ntfs3` accepts the option
  (tested 2026-11-15 by mounting `throwaway-ntfs` with the engine) and really rejects
  such names: a name with a colon and a name ending in a dot were both refused, a
  normal name worked (tested 2026-11-15 with `scripts/enginetest.sh windows-names`).
- **FS-4 (Agreed)** Files appear owned by `nobody:users` (99:100), the Unraid
  convention. Mount with `nosuid,nodev`. Files created on Bob keep the Linux owner of
  whoever created them (test 1); accepted for version 1. Files and folders created
  over the plugin's SMB share belong to `nobody:users` (tested 2026-11-16, test 10).
- **FS-5 (Agreed)** A volume marked dirty (after a crash or power cut) is **not**
  force-mounted. The plugin reports it and explains the repair: `chkdsk` on Windows for
  NTFS. For exFAT, offer `fsck.exfat` after explicit confirmation.
- **FS-6 (Agreed 2026-11-17)** On ext4, XFS and Btrfs the top folder of a new volume
  belongs to `root:root` with `0755`, so its share (which writes as `nobody:users`)
  cannot write. The mount never changes permissions by itself. When a saved volume with
  a read-write share is mounted read-write and its top folder blocks the share, the page
  asks "Allow writing over the network?"; on yes, `vcmount fix-top` sets only the top
  folder to `nobody:users` and `0777`. The information window shows the top folder's
  owner and mode, with "Let the share write" (the same) and "Fix permissions…", which
  after a confirmation runs Unraid's `newperms` on the whole volume in the background.

### 5.4 Mount location and sharing

- **MNT-1 (Agreed)** Default: each volume gets its own mount point under
  `/mnt/addons/<name>`.
- **MNT-2 (Agreed)** Alternative, per volume: mount into a folder inside an existing
  user share. The UI warns that everything that walks that share (backups, indexers,
  activity loggers) then walks into the decrypted data, and that the mount is not
  visible through per-disk paths.
- **SHR-1 (Agreed, detailed 2026-11-16)** Per volume, optional SMB share (appears as
  `\\Bob\<name>`), with access limited to chosen Unraid users, each read-write or
  read-only. Set up like Unraid's own share settings: "Export: Yes / Yes (hidden)" and a
  table with No access / Read-only / Read/Write per user. Only Unraid's "Private"
  security is offered; "Public" and "Secure" are left out because they would give
  guests access to the decrypted data.
- **SHR-2 (Agreed)** Option to hide the share from network browsing.
- **SHR-3 (Agreed, confirmed 2026-11-17)** Implement sharing the way Unassigned Devices
  does, without editing Unraid's own Samba configuration files. Built that way: one file
  per share in `/etc/samba/veracrypt-shares/`, included from `smb-unassigned.conf`,
  which Unraid's `smb.conf` already includes (DESIGN-engine, section 9b; test 10).

### 5.5 Docker control

- **DOC-1 (Agreed)** Per volume, an ordered list of dependents. A dependent is a single
  container (by name) or a Compose stack (by project name).
- **DOC-2 (Agreed)** Dependents run only while their volume is mounted.
- **DOC-3 (Agreed)** On mount: start dependents in list order, with an optional delay
  between them. A dependent that fails to start does not hold back the others: the
  volume stays mounted, the remaining dependents are still started, and the fault is
  reported with a notification.
- **DOC-4 (Agreed)** On dismount: stop dependents gracefully and with enough time.
  Agreed detail: reverse order, grace period per dependent, default 10 seconds, as Docker's own `docker stop` (60 until 2026-11-27: two dependents
  with 60 already exceeded their share of the shutdown time-out). A dependent that needs
  longer is killed and reported (DOC-5), so its grace period can be raised.
- **DOC-5 (Agreed, changed 2026-11-15)** If a dependent has not stopped within its
  grace period, it is **killed** and the dismount continues. The kill is logged and
  reported with a notification. Reason: dismounting the volume matters more than a
  clean stop of a dependent, and a dependent must not keep running without its volume.
- **DOC-6 (Agreed, built 2026-11-27)** A dependent started by hand while its volume is locked is stopped
  again, with a notification.
  Built as part of the minute check (`vcmount check`, run by cron with the idle lock): a
  dependent running while all volumes it belongs to are locked is stopped within about a
  minute, with its grace period. The folder Docker created for it is removed if it holds
  no file; otherwise the notification says it may hold data (in RAM under /mnt/addons/)
  that must be moved or deleted before mounting, and the mount's refusal says the same.
  Docker is asked for names only, from memory, without the lock and with a 10-second
  limit; the lock is taken only when something has to be stopped.
- **DOC-7 (Agreed, built 2026-11-27)** Conflict check: warn if a dependent has Unraid autostart enabled or
  a Docker restart policy (`always`, `unless-stopped`) that would start it before the
  volume is mounted.
  Built: `vcmount options` reads Unraid's autostart list (`/var/lib/docker/unraid-autostart`)
  and each container's restart policy; the edit panel marks such a dependent on its row
  ("autostart on", "restart policy"), explains below the list and shows the mark on the
  closed section too. DOC-6 (stopping one started by hand) is not built yet: it needs a
  watcher of Docker's events.
- **DOC-8 (Agreed)** Both Unraid-template containers and Compose stacks are supported.
  Version 1 starts and stops existing containers; full `up`/`down` integration with
  Compose Manager can follow.
- **DOC-9 (Agreed)** Appdata inside the volume is **optional, default off**. Version 1
  only shows, per dependent, which of its host paths lie inside and outside the volume,
  so the user can move paths deliberately. The plugin does not move data.

### 5.6 Lifecycle and safe dismount

- **LIFE-1 (Agreed)** On array stop, shutdown and reboot: dependents are stopped
  gracefully, then all volumes are dismounted, before the array disks unmount.
- **LIFE-2 (Agreed, confirmed 2026-11-17)** Hook the right Unraid events. Names and
  order confirmed on 7.4 (test 8). The plugin hooks `stopping_docker` (stop dependents
  while Docker still runs) and `unmounting_disks` (dismount all before the disks
  unmount); array stop, reboot and the power-cycle recovery were tested with them.
- **LIFE-3 (Agreed, built 2026-11-27)** Warn if the sum of grace periods exceeds Unraid's
  shutdown timeout, because Unraid forces the shutdown after that. The edit panel warns
  when a volume's dependents need more than half of it, the share the `stopping_docker`
  hook has; the engine then shortens the grace periods to fit (audit S2).
- **LIFE-4 (Agreed 2026-11-17)** If the Docker service is stopped or restarted, dependents
  follow the same rules as above. Unraid fires `stopping_docker` and `docker_started`
  also when Docker is switched off and on in Settings › Docker (test in section 10).
  The `stopping_docker` hook already stops the dependents with their grace periods;
  the `docker_started` hook starts the dependents of every mounted volume in list
  order (`vcmount start-dependents --all`), in the background so Unraid's start does
  not wait. At array start no volume is mounted yet, so it does nothing there.
- **LIFE-5 (Agreed, changed 2026-11-15)** A busy dismount is not forced by default. It
  aborts and the plugin shows what holds the volume open (processes, network clients).
  The user can then repeat it with an explicit **force** option. Force ends whatever
  holds the volume open (programs on the server get the stop signal, a short wait, then
  are killed; network clients are disconnected from the share) and then dismounts
  normally, so the filesystem is closed cleanly and the volume is really locked. A
  "lazy" dismount, which hides a volume but leaves it unlocked, is never used.
- **LIFE-10 (Agreed)** On array stop, shutdown and reboot the dismount uses force. A
  setting turns this off. Reason: otherwise a busy volume makes the array stop hang, or
  Unraid cuts the power with the volume still mounted.
- **LIFE-6 (Agreed)** Plugin update and removal while volumes are mounted are refused
  with a clear message. The plugin does not dismount automatically in this case; the
  user dismounts first and then repeats the update or removal.
- **LIFE-7 (Agreed)** State is read from the live system (device mapper, mount table),
  not from files, so it survives plugin updates and is correct after a crash.
- **LIFE-8 (Agreed, built 2026-11-27)** Optional idle auto-lock per volume, default off.
  Built as agreed on 2026-11-27: a checkbox "Lock when idle" with 15 minutes offered
  (5 to 1440); "idle" means the kernel's read and write counters of the unlocked volume
  (`/sys/block/dm-N/stat`) did not change; checked once a minute by cron; the lock is a
  normal dismount (dependents first, their activity counts), never forced; a file still
  open keeps the volume mounted, with one notification; every auto-lock is notified. A
  countdown shows on the Volumes tab, Main and the tile. Design: DESIGN-engine section
  10a. Tested on Bob: idle volume locked; activity resets the time; an open Word
  document keeps it mounted until closed.
  Later (2026-11-27, back burner): the same counters could give the Main page section
  Reads and Writes columns like Unraid's device tables; the mount point would then need
  a new place.
- **LIFE-9 (Agreed)** Unraid notifications for failed mounts, aborted dismounts,
  auto-locks and stopped dependents.

### 5.7 User interface

- **UI-1 (Agreed)** Looks Unraid-native, and sleek: follows the active theme, works on
  narrow screens, uses Unraid's own controls and dialogs.
- **UI-2 (Agreed)** A Dashboard tile showing volume status with quick mount and
  dismount.
- **UI-3 (Agreed)** One page under Settings, in the User Utilities section, with two
  tabs: the volume list (Mount, Dismount, add, edit) and the settings. A setting, off by
  default, also shows the volume list as a section on the Main page. While it is off,
  the plugin adds nothing to the Main page. Mockups are in `mockups/index.html`.
- **UI-4 (Agreed)** Password fields are real password fields so browser password
  managers work.
- **UI-5 (Agreed, changed 2026-11-17)** A "require HTTPS" setting blocks unlocking
  from a page opened over plain HTTP: the page then offers no password field at all,
  and the server refuses such a mount as well. The setting is **on by default**; users
  without HTTPS switch it off once on the Settings tab, and then unlocking over plain
  HTTP works with a visible warning. An existing settings file keeps its saved choice.
- **UI-6 (Agreed)** The owner reviews mockups before any UI is built.
- **UI-7 (Agreed, 2026-11-26)** While unlocking, the mount dialog shows the time taken
  against the engine's limit of 3 minutes, with a short note on why unlocking is slow.
  A PIM above 2,000 (over four times VeraCrypt's default effort) is sent only after a
  warning and a second click; the warning does not show the PIM.
- **UI-8 (Agreed, 2026-11-26)** Cancel ends a running unlock. The page only asks:
  `vcmount cancel-unlock` creates the marker `/var/run/vcmount/cancel`, holding the
  random ID of the one unlock it is for (review C3). The mount, which waits for
  `cryptsetup` anyway, looks for it every half second and ends its own child; no
  process number is passed around, so it cannot hit another program. A cancel for
  another unlock is ignored, so a late one cannot stop the next unlock, and one sent
  just before its unlock starts is still honoured. Cancel after the password was
  accepted changes nothing: the mount completes. Ctrl+C, a closed terminal and a stop
  signal (also the page's own time limit) are caught during the password check and end
  cryptsetup the same way; otherwise it would run on alone, since it ignores them until
  its key derivation ends. While the check runs, `/var/run/vcmount/unlocking` holds its
  start time and its random ID (no name, no path). A mount that finds the engine busy says at once what
  is running and, for another unlock, offers to stop it, instead of waiting with its
  own timer. Needs a short separate review (SEC-9).

### 5.8 Command-line tool

The design is in `docs/DESIGN-engine.md`.

- **CLI-1 (Agreed)** One command-line tool, `vcmount`, written in PHP, is the single
  engine. The web UI and the event hooks call it; they contain no mount logic of their
  own.
- **CLI-2 (Agreed)** It can list, show status, mount and dismount, and manage
  dependents. Secrets are read from standard input only.
- **CLI-3 (Agreed)** Usable over SSH, which gives an encrypted way to unlock even
  while the web UI is on HTTP.

## 6. Security requirements

- **SEC-1** Passwords, PIM values and keyfile contents never appear in command-line
  arguments, environment variables, files, logs, notifications or the configuration.
  They are passed to `cryptsetup` through standard input or a pipe and discarded.
- **SEC-2** Every state-changing web request carries and checks Unraid's CSRF token.
- **SEC-3** No user input is ever interpolated into a shell command. Volume names are
  restricted to a safe character set; paths are validated and resolved before use.
- **SEC-4** The configuration on the flash drive contains no secrets. Volumes mounted
  without saving leave nothing behind.
- **SEC-5 (Dropped 2026-11-15)** The plugin adds no waiting time after failed unlock
  attempts. Each attempt takes as long as `cryptsetup` needs to check a password.
- **SEC-6** No dependencies beyond what Unraid ships.
- **SEC-7** The plugin never modifies a volume header and never opens a volume it was
  not asked to open.
- **SEC-8** Development and automated tests use throwaway volumes only, never real data.
- **SEC-9** Before each release, the secret-handling code gets a separate review by a
  reviewer that did not write it.

## 7. Privacy

- **PRIV-1** The plugin's log records events only (mounted, dismounted, failed), never
  file names from inside a volume.
  Since 2026-11-17 a setting **"Show volume names in logs"** (off by default) decides
  whether those events, and the fault notifications, name the volume and its
  containers. Off, every name is replaced by "(name hidden)", because Unraid copies the
  system log to the flash drive at shutdown, puts it into diagnostics and archives
  notifications on the flash. The information window then shows no log history.
- **PRIV-2** For volumes mounted without saving, nothing identifying is logged.
- **PRIV-3 (Agreed, extended 2026-11-16)** Warn when a known activity-logging plugin
  (for example File Activity) is installed and could record file names from mounted
  volumes. The warning strongly recommends adding exclusions and offers a simple way:
  the exact exclusion lines, ready to copy, for every mount point (most important:
  logging a volume's content is worse than logging where the volume file is) and for
  the folders that hold the volume files. File Activity has an "Exclusions" list in its
  settings, one RE2 pattern per entry. The plugin does not change another plugin's
  settings by itself.
  Built 2026-11-16 (`vcmount privacy`, warning box on the Volumes tab): File Activity's
  settings (`/boot/config/plugins/file.activity/config.json`, read only) are checked
  against sample paths for every mount point and volume folder; the warning shows while
  one is not left out. Because File Activity takes one pattern per entry, it offers
  **one** line covering everything, for example
  `^/mnt/(addons|[^/]+/data/veracrypt)(/|$)`: all of `/mnt/addons` (it holds only
  plugin mounts and also covers volumes added later), each folder holding volume files
  and each mount point inside a share. `[^/]+` covers both spellings of a share path
  (`/mnt/user/...` and `/mnt/diskN/...`). File Activity finds a pattern anywhere in a
  path (its defaults such as `(?i)appdata` have no anchors), hence the `^`.
  Found 2026-11-16 on Bob: File Activity logged 225 accesses to the volume files in
  `/mnt/user/data/veracrypt/` and nothing from `/mnt/addons`, which it does not watch.
  A volume mounted inside a user share (MNT-2) would be watched.
- **PRIV-4** Documentation states the leaks the plugin cannot prevent: a dependent's
  appdata outside the volume, traces on Windows clients (recent files, thumbnails), and
  activity-logging plugins that record when volume files are opened.
  Added after the review of 2026-11-17 (`docs/REVIEW-secrets.md`, H4, H5): "mount once"
  over SSH leaves the volume file's path in root's shell history (in RAM, gone after a
  reboot) and briefly in the process list, so use the web page for volumes that must
  leave no trace. Added after the second review (K5): while a volume is being mounted,
  the paths of its file and keyfiles are visible in the process list, also from the
  web page; browsers may ignore "do not save" on password fields and still offer
  to save a "mount once" password.

## 8. Known limits and accepted risks

- Encryption protects data **at rest**. While a volume is mounted, anything with root
  on the server can read it, including other management tools and anyone who can log
  in to the web UI.
- There is no hidden-volume protection; the read-only switch is the safeguard.
- A volume must never be mounted on the server and on Windows at the same time.
- FAT32, exFAT and NTFS carry no Unix permissions; some Docker applications (databases
  especially) will not run from them.
- exFAT has no journal and is the more fragile choice after a power cut.
- Over plain HTTP the volume password crosses the LAN unencrypted.
- "No security issues" cannot be guaranteed. The mitigations are a narrow design,
  throwaway test volumes and a separate review.

## 9. Maintainability

- Borrow the folder layout of the community plugin template
  (`dkaser/unraid-plugin-template`, reviewed 2026-11-15): `src/` mirrors the server's
  file system, `plugin/` holds the `.plg` template. The template is not copied wholesale;
  its release action, code checkers and `customize.sh` are not used.
- One small build script of our own builds the package. The same script runs locally
  and, later, in GitHub Actions.
- Date-based versions. GitHub Actions builds the package and updates the `.plg`. The
  release workflow uses only GitHub's own actions, pinned to fixed versions.
  Built 2026-11-16 (`.github/workflows/release.yml`): `scripts/build.py <version>` is
  run locally and writes version and SHA256 into the `.plg`; the `.plg` is committed and
  the version pushed as a tag. The workflow rebuilds from the tag, refuses unless the
  committed `.plg` describes exactly this package (`build.py --check`; builds are
  reproducible because every file carries midnight UTC of the version's date), and
  publishes package and `.plg` as a GitHub release. It never writes to the repository;
  it uses `actions/checkout` (v7.0.1 since 2026-11-17) pinned to a commit and the `gh` command of GitHub's
  runners. While the repository is private (decided 2026-11-16), Unraid cannot download
  from it, so installs stay local.
- Licence: MIT.
- Unix line endings enforced through `.gitattributes` from the first commit.
- Plugin ID: `veracrypt.mount` (agreed 2026-11-15); display name "VeraCrypt Mount".
- Configuration: one JSON file on the flash drive,
  `/boot/config/plugins/veracrypt.mount/volumes.json`, written only when the user saves
  settings, never by mounting or dismounting.

## 10. To verify on the server before building on it

Each item is a small test against a throwaway volume. The throwaway volumes are, in
`/mnt/user/data/veracrypt/`: `throwaway-ntfs`, `throwaway-exfat` and `throwaway-argon`
(NTFS, Argon2). The tests are run with `scripts/vctest.sh`.

1. Map and mount an NTFS volume read-write with `ntfs3`; write, dismount, open on Windows.
2. The same for exFAT. *Deferred (2026-11-15): do it when the related part is built.*
3. Open a hidden volume. *Deferred (2026-11-15): lower priority for now.*
4. Open with keyfiles, with PIM, and with both. *Deferred (2026-11-15): lower priority
   for now.*
5. Ciphers and hashes other than AES and SHA-512, if the owner's real volumes use them.
   *Not needed (2026-11-15): the real volumes use AES, SHA-512 with PBKDF2, NTFS and
   passwords only.*
6. A volume created with Argon2id: does cryptsetup 2.8.8 open it? *Deferred (2026-11-15): do it when the related part is built.*
7. Behaviour with a dirty NTFS volume. *Deferred (2026-11-15): do it when the related part is built.*
8. Unraid event names and their order on 7.4.
9. Whether File Activity v2 watches `/mnt/addons`.
10. How to add and remove an SMB share cleanly at runtime.
11. How Dashboard tiles are registered on 7.4.
12. Opening the backing file by its real disk path versus the `/mnt/user` path. *Deferred (2026-11-15): do it when the related part is built.*

### Results

**Test 1, NTFS read-write with `ntfs3` (2026-11-15, passed, on `throwaway-ntfs`).**

- Header read, unlock, mount, write, dismount and lock all succeeded at the first
  attempt with `cryptsetup` 2.8.8 and the kernel driver `ntfs3`. The password went
  through standard input only.
- `cryptsetup` creates the loop device for the volume file itself and releases it again
  on `cryptsetup close`.
- On Windows afterwards: the volume mounted in VeraCrypt without a repair prompt, the
  file written on Bob was there and readable, existing files opened, and a Windows
  disk check found the filesystem fully clean.
- Finding for FS-2 and FS-4: `ntfs3` stores Linux ownership inside the volume for files
  created on Linux. The file written by root appeared as `root:root`, writable by root
  only, while files created on Windows appeared as `nobody:users` as the `uid` and
  `gid` mount options asked. Decide in the design step how files created on Bob should
  be owned.

**Test 8, event names and order (2026-11-15, read from `/usr/local/sbin/emhttp_event`
on Unraid 7.4).** All candidate names in LIFE-2 exist.

- Array start, in order: `startup`, `driver_loaded`, `starting`, `array_started`,
  `disks_mounted`, `svcs_restarted`, `docker_started`, `libvirt_started`, `started`.
- Array stop, in order: `stopping`, `stopping_libvirt`, `stopping_docker`,
  `stopping_svcs`, `unmounting_disks`, `stopping_array`, `stopped`.
- `unmounting_disks` runs after the network services have stopped and before any disk
  is unmounted. `stopping_docker` runs just before Docker is stopped.
- A plugin hooks an event with an executable file (or a folder of them) at
  `/usr/local/emhttp/plugins/<plugin>/event/<event name>`. Plugins are called in
  alphabetical order of their folder names.
- Unraid waits until each hook has finished, so a hook can hold up an array stop for as
  long as it runs. Hooks must therefore have a time limit.
- Not shown by this file: whether shutdown and reboot go through the same stop events.
  Answered 2026-11-15 by reading `/etc/rc.d/rc.local_shutdown`: at shutdown and reboot
  it sends Unraid the same "stop the array" command as the Stop button (`cmdStop`), so
  the same stop events run and the hooks are called.
- That command gets a time limit, Unraid's shutdown time-out (`shutdownTimeout` in
  `/var/local/emhttp/var.ini`, 90 seconds if not set). When it runs out, Unraid logs
  "Forcing shutdown...", writes diagnostics and shuts down anyway. A volume that is
  still busy then is **not** dismounted cleanly. This is Unraid's doing, not the
  plugin's; it matters for LIFE-3 and for the time limit of the hook.
- `/usr/local/sbin/powerdown` only hands over to `/sbin/init 0` or `/sbin/reboot`.
  `/etc/rc.d/rc.6` itself does not mention the array stop.

**Test 11, Dashboard tiles (2026-11-15, read from installed plugins on Unraid 7.4).**

- A plugin registers a tile with a page file whose header has the line
  `Menu="Dashboard:0"`. Eight such files from seven plugins are installed and working.
- The page's PHP code hands the tile to Unraid by setting
  `$mytiles['<tile id>']['column1']` (or `column2`, `column3`) to a piece of HTML that
  starts with `<tbody title="...">`. The column number is the Dashboard column the tile
  appears in by default.
- The Tailscale tile wraps this in an error handler, so a fault in the tile shows a short
  message instead of breaking the Dashboard. Worth copying.
- The HTML inside the tile (header, icon, buttons) was not examined here. The template's
  sample tile shows the layout for Unraid 7.2 and later; check it on 7.4 when the
  mockups are built.

**Test 9, File Activity and `/mnt/addons` (2026-11-15, answered; File Activity is
installed and switched on on Bob).**

- Practical check: a file written inside a throwaway volume mounted at
  `/mnt/addons/vctest-ntfs` did **not** appear in File Activity's record. A control
  search showed the record was working at that moment.
- Access to the volume file itself **is** recorded: every open, read and write of
  `/mnt/disk5/data/veracrypt/throwaway-ntfs`, with time stamps. So File Activity shows
  which volume file was in use and when, but not what was done inside it.
- Its pages only show activity under `/mnt/disk<N>/`, `/mnt/disks/` (Unassigned Devices)
  and `/mnt/<pool>/`.
- Its record is kept in RAM (`/var/log/file.activity/data.log`) and is lost at reboot.
- Not tested: a volume mounted inside a user share (MNT-2).

**Test 10, SMB shares at runtime (2026-11-15, read from `/etc/samba/` and the code of
Unassigned Devices on Unraid 7.4).**

- Unraid's own `/etc/samba/smb.conf` contains a ready-made hook:
  `include = /etc/samba/smb-unassigned.conf`, commented "hook for unassigned devices
  shares". That file exists and is empty on Bob at the moment.
- Unassigned Devices keeps one small settings file per share in
  `/etc/samba/unassigned-shares/` and refers to them from `smb-unassigned.conf`.
- To add a share it then runs `smbcontrol all reload-config`. To remove one it runs
  `smbcontrol all close-share <name>` first, then the reload. No Samba restart is needed.
- All of `/etc/samba/` is in RAM, so nothing of this survives a reboot.
- How Unassigned Devices rewrites `smb-unassigned.conf` (read 2026-11-16 in its
  `include/lib.php`, functions `add_smb_share` and `rm_smb_share`): it reads the whole
  file, keeps every line that is not an `include` line, keeps every `include` line whose
  target file exists, and drops `include` lines whose file is gone. That is also how it
  removes its own shares: it deletes the share's file and lets this cleanup drop the line.
  It takes no lock. Each share file ends with a `[global]` line, so that the next
  include does not land inside that share.
- Result: this plugin can add its own `include` lines to `smb-unassigned.conf`. They
  survive as long as their files exist. The only risk is both plugins writing in the same
  instant; the plugin repairs its own lines (`vcmount repair-shares`). The alternative
  hook, `/boot/config/smb-extra.conf`, is on the flash drive and is ruled out by the
  "flash is not written at runtime" rule.
- Design agreed 2026-11-16: one file per share in `/etc/samba/veracrypt-shares/`, an
  `include` line in `smb-unassigned.conf`, `smbcontrol all reload-config`; on removal
  the reload comes first, then `smbcontrol all close-share`. Details in
  `docs/DESIGN-engine.md`, section 9b.
- Tried in practice 2026-11-16 on `throwaway-ntfs`, both passed:
  - `scripts/enginetest.sh share`: mounting added `\\Bob\share-test`; Samba (read with
    `testparm`) saw it hidden, read-only and limited to one user; `status` showed it.
    After its include line was taken out on purpose, `repair-shares` put it back.
    Dismounting removed the share file and the include line, and Samba no longer knew
    the share. The lines of other plugins in `smb-unassigned.conf` were unchanged.
  - `scripts/enginetest.sh share-clash`: a volume named like an existing user share
    (`appdata`) was mounted, its share was refused with code 8, nothing was written.
- From Windows, 2026-11-16, both passed: with `share-test` mounted and shared
  read-write for the test user, the owner created and renamed a file and created a folder in
  `\\Bob\share-test`. On Bob both belong to `nobody:users` (99:100). Then, with
  `throwaway-ntfs` mounted in VeraCrypt on Windows from `\\Bob\data\veracrypt\`,
  `vcmount mount throwaway-ntfs` was refused with code 3, "the volume file is open over
  the network" (VOL-7). Small gap: the message says "a network client" instead of the
  user name, so the user-name field in Samba's answer is not the one the engine looks for.

**Web action tests (2026-11-16, both passed, run with `scripts/actiontest.sh`).** They
call `include/actions.php` the way the web page will, without a browser.

- `config`: unknown actions, bad names and empty settings are refused before the engine
  starts; `options` lists the Unraid users and the containers; `list` returns the
  settings; `save-config` writes valid settings (unknown fields dropped, defaults filled
  in, no temporary file left) and refuses nine kinds of invalid settings with the file
  left unchanged.
- `mount`, on `throwaway-ntfs`: over plain HTTP with "require HTTPS" on, the mount is
  refused with code 3 and the volume stays locked; a password with a line break is
  refused before the engine starts; with the setting off, mount, status and dismount
  work, with the password handed over as the web page will.
- Browser test of the Volumes tab (2026-11-16, the owner at the keyboard, installed with
  `scripts/deployweb.sh`): mount with a wrong and the right password, dismount, mount a
  file once, a quick double click on Mount (sends one request), and a mount done over
  SSH appearing on the page within 5 seconds. All passed. The browser no longer offers
  to fill in the fields of "Mount a file once".
- First attempt failed in a misleading way ("another action is running", "already
  mounted"). Cause: Unraid's web server was crashing more than once a second (known
  Unraid bug, "worker process exited on signal 6"), started at 06:36 by a stale Unraid
  tab in a phone browser. The browser resent the dropped requests. It stopped once all
  Unraid tabs were closed. The page now ignores a second click while a mount is on its
  way, and after a lost answer it waits for the engine (`vcmount busy`) and reports
  from the volume's real state.
- Password search (`scripts/logcheck.sh`): after a mount through the page and one over
  SSH, the throwaway password was found nowhere under `/var/log` or `/tmp` on Bob. The
  first search was useless because the old throwaway password was a common word; the
  test volumes now have a password that does not occur by chance.
- Browser test of the edit panel (2026-11-16, the owner at the keyboard): add a volume
  (the name is filled from the file name when empty), edit, per-user share access,
  Mount all, and files written over SMB to `throwaway-exfat`. All passed. Changed
  after his review to work like Unraid's own share page: "Add Volume" saves and returns
  to the list; under Edit, Apply is greyed out until something changes and stays on the
  page, Done turns into Reset, and Reset brings back the saved settings. The way back
  is a breadcrumb in Unraid's title bar, as in Unraid's file manager. "Mount read-only"
  sits under the volume file and leaves the saved share access alone; users with
  Read/Write get a hint, and the engine gives nobody write access while the volume is
  mounted read-only.
- Browser test of the Settings tab (2026-11-16, the owner at the keyboard): the three
  settings are shown and saved; with "Require HTTPS to mount" on, a mount over plain
  HTTP is refused; Apply, Done and Reset work as on the edit panel. Passed.
- Browser test of the Dashboard tile (2026-11-16, the owner at the keyboard): mount
  and dismount through the lock, the dismount confirmation, the link from a name to
  its Edit screen, the Share column and the fold arrow. Passed. Laid out like Unraid's
  Array tile after his review (Unraid's own columns, status dot and usage bar; the
  lock in front of the name is the control and previews its action on hover).
- The first version of the tile left the whole Dashboard blank. Cause: Unraid's
  Dashboard script reads the title of every `tbody` on the page (`DashStats.page`,
  `addProperties`), and the tile contained a table of its own, so a `tbody` without a
  title. Rule since then: no table inside the tile; rows go into the tile's own
  `tbody`, as Unraid does for the Array tile.
- Browser test of the Main page section (2026-11-16, the owner at the keyboard): hidden
  while "show on the Main page" is off, shown after Boot Device when on; mount and
  dismount through the lock, the file manager link, FS (ntfs, exfat), Size, Used and
  Free in Unraid's column grid. Passed. Before installing, the section's `Cond` line
  was evaluated by PHP on Bob the way Unraid reads it (header intact, result as set).
  The section opts out of Unraid's "Toggle reads/writes display" icon
  (`disable_diskio`), since it shows no reads or writes.
- File Activity warning (PRIV-3, 2026-11-16): `vcmount privacy` on Bob found File
  Activity, accepted the existing `^/mnt/addons(/|$)` entry as covering the mount points
  and named only `/mnt/user/data/veracrypt` as missing. The owner added the offered line
  in File Activity; the warning on the Volumes tab then went away. Passed.
  With the line in place, the owner wrote files to `throwaway-ntfs` (Unraid's file
  manager) and to `throwaway-exfat` (SMB). File Activity's current record (21:11 to
  21:51, last entry written during the check) holds **no** entry for
  `data/veracrypt` or `/mnt/addons`; its previous record holds 142, the last at 15:37,
  before the line was added. Checked with counts and timestamps only, no file names
  shown. Passed.
- Dependents through the web page (2026-11-16, three throwaway containers
  `vcm-test-a/b/c` from `alpine:3.21`, no network, removed afterwards): drag and drop
  in the edit panel saves the order; mounting `deps-test` started them in the saved
  order 2 seconds apart (the set delay), dismounting stopped them in reverse. `sleep`
  ignores the stop signal, so each ran out its grace period and was killed (exit 137),
  as designed. Passed. Drag and drop was made steadier after this (as on Unraid's Docker
  page: a copy follows the mouse, the gap keeps its size, the pointer decides).
  The Volumes tab shows "Dismounting…" with a spinning lock while a dismount runs.
- No extra "force" for slow dependents (decided 2026-11-16): each dependent's grace
  period already caps the wait, and a busy volume already offers Force dismount with a
  second confirmation (LIFE-5). Killing dependents early would risk damaging files on
  the volume. Possible later: show which container is being stopped during a dismount.
- Packaging (2026-11-16): `scripts/build.py` builds a Slackware package from `src/`
  (owner root, fixed permissions, refuses Windows line endings and settings or secret
  files) and writes version and SHA256 into `plugin/veracrypt.mount.plg`. Laid out like
  Bergware's `dynamix.system.info` (package installed with `upgradepkg`, removed with
  `removepkg`); dlandon's `recycle.bin` read for comparison. Unraid 7.4's plugin
  manager checks SHA256. Installed on Bob with `plugin install` from a local `.plg`,
  the package already on the flash; the checksum matched and the install was clean.
- Real reboot with two volumes mounted (2026-11-16): `throwaway-ntfs` shared over SMB
  with a file open on Windows, and `throwaway-exfat`. Saved log
  `/boot/logs/syslog-previous`: shutdown 23:21:00; both volumes dismounted at 23:22:18,
  one second before Unraid unmounted `/mnt/user` and the array disks, which then went
  cleanly; the shutdown ran to the end. At boot the plugin manager reinstalled the
  package from the flash (SHA256 checked); the volume list was kept, both volumes were
  locked, and no unclean shutdown was reported. Passed. This closes the reboot gap above.
  At the next boot the flash drive (new) did not answer on USB (`device descriptor
  read`, `Device not responding to setup address`, `/boot` not mounted); a full power
  cycle cured it. This happens before Unraid reads the flash, so it is unrelated to the
  plugin. If it repeats, try a rear USB 2.0 port.
- Removal (2026-11-16). With `throwaway-ntfs` mounted and a shell sitting in it, removal
  through the Plugins page was refused: "Not removed: a volume is still mounted and in
  use", and Unraid's plugin manager stopped ("run failed: '/bin/bash' returned 1").
  All files, both hooks, the `.plg`, the package and `volumes.json` stayed; the volume
  stayed mounted. Unraid's page nevertheless said "Finished" and hid the plugin until
  the list was reloaded, so our message in the output window is the only accurate hint
  (possible later: also send an Unraid notification). After leaving the volume, removal
  ran through: plugin folder, `vcmount` command, share files and the package on the
  flash were gone, no volume unlocked or mounted, the Samba include line removed, the
  plugin and package records gone. Left on the flash, as intended: only
  `veracrypt.mount/volumes.json`. Passed.
- Plugins list and update (2026-11-16): Unraid's Plugins page takes name and
  description from `README.md` in the plugin folder and accepts only a font icon or a
  PNG as icon (`dynamix.plugin.manager/include/ShowPlugins.php`). Added a README and a
  dark grey PNG of the VC lock, drawn by `scripts/make-icon.py` with Python's own
  modules. Version 2026.11.16a installed over 2026.11.16 as an update: `upgradepkg`
  replaced the package, the old one was deleted from the flash, volumes kept. Passed.
  While the GitHub repository is private, the page's update check cannot fetch the
  `.plg`, shows "not available" and sorts the plugin last; this goes away once the
  repository is public.
- Public release and install from GitHub (2026-11-17). The repository was published
  with a fresh history (the old one stays private as `unraid-veracrypt-mount-dev`).
  The first release run (tag `2026.11.17e`) refused to publish: its package had a
  different checksum than the `.plg`, because Windows sorted the package's files
  without regard to case and Linux with it. Fixed by sorting on the plain path text;
  a local build then gave GitHub's checksum exactly. Release `2026.11.17f` was built,
  checked and published by the workflow. On Bob the plugin was removed and installed
  from `https://raw.githubusercontent.com/bentrop/unraid-veracrypt-mount/main/plugin/veracrypt.mount.plg`:
  the `.plg` and the package were downloaded from GitHub and checked, the volume list
  was kept, and the Plugins page shows "up-to-date" in alphabetical order. Passed.
- Polish (2026-11-17, version 2026.11.17g): the Settings tab's explanations use Unraid's
  own help toggle (`blockquote.inline_help`, shown by the "?" or by clicking a
  setting's name); usage bars are coloured by Unraid's own rule (`usage_color` in
  `Helpers.php`: green, orange from the warning level, red from the critical level,
  none when Display Settings turn colours off); the Volumes tab leaves out second
  lines that only said "not shared", "none" or "locked". Checked by the owner on the
  light and on the black theme; locks, banner, grey text and bars stay readable.
  Passed. Kept on purpose: the lock colours that match each page (black on the
  Dashboard, Unraid's link blue on the Main page and the Volumes tab), the plain-HTTP
  banner, and the tile's column layout.
- Volume information and log names (2026-11-17, versions 2026.11.17i and j): the drive
  icon (Main page: before the volume file; Volumes tab: after the lock) opens a window
  with what `vcmount info` reads without the password: volume file, encryption
  (`cryptsetup status`), file system (`blkid`, mount options), share, dependents with
  their state, and, only when names may be logged, the plugin's recent log lines for
  the volume. With "Show volume names in logs" off (the default), a dismount on Bob was
  logged as `veracrypt.mount: dismounted (name hidden)`. Passed. Lock colours follow
  Unraid's status colours: mounted `--green-200`, locked the theme's text colour.
- All file systems of FS-1 (2026-11-17, version 2026.11.17k). Test volumes made from
  copies of `throwaway-ntfs` (unlocked with `cryptsetup`, inside reformatted with
  `mkfs.ext4`, `mkfs.btrfs --mixed`, `mkfs.vfat -F 32`; the VeraCrypt header and
  password unchanged) and a 400 MB volume for XFS (`mkfs.xfs` needs about 300 MB; label
  at most 12 characters). `scripts/fstest.sh` on each: write a file, dismount, mount
  read-only (options show `ro`, the file is readable, writing is refused), mount
  normally, remove the file. Passed for ext4, Btrfs, FAT32 (saved volumes, shared) and
  XFS (as "mount once"). Owners as designed: `root:root` on ext4, Btrfs and XFS,
  `nobody:users` on FAT32. Afterwards the password was found in no log, and the "mount
  once" name in no log line. Found and fixed: FAT32 was mounted with the kernel's old
  `iso8859-1` character set; it now gets `utf8`.
- Top folder and SMB writes (FS-6, 2026-11-17, version 2026.11.17l). Before: writing
  over SMB worked on FAT32 and NTFS but failed on ext4, Btrfs and XFS (top folder
  `root:root 0755`). Remounting `throwaway-ext4` asked the question, "Set it" let
  Windows write to the share; on `throwaway-btrfs` "Let the share write" in the
  information window changed the folder to `nobody:users, 0777` and Windows could
  write; "Fix permissions…" asked first and ran. Passed.
- Speed through the share path and the disk path (VOL-8, 2026-11-17). `throwaway-400-xfs`
  on array disk 5, mounted "once" through `/mnt/user/…` and through `/mnt/disk5/…`;
  `scripts/speedtest.sh`, three rounds of writing 250 MB (with fsync) and reading it
  back after emptying the read cache. Share path: write 46–66 MB/s, read 216–231 MB/s.
  Disk path: write 25–60 MB/s, read 19–204 MB/s. The disk path was no faster; its
  uneven numbers suggest other disk activity during that run. Writes are limited by
  parity, reads by the disk.
- Docker switched off and on (LIFE-4, 2026-11-17, before the `docker_started` hook).
  Throwaway containers `vcm-test-a/b` (`alpine:3.21`, no network) as dependents of
  `throwaway-exfat`, mounted and running; Docker set to "No" and back to "Yes" in
  Settings › Docker. The `stopping_docker` hook ran: `vcm-test-b` stopped at 17:10:06.0,
  `vcm-test-a` at 17:10:06.9, Unraid's `rc.docker stop` began at 17:10:07. After the
  start the dependents stayed stopped, although the volume was mounted: the gap the
  `docker_started` hook closes.
- The same with the `docker_started` hook (version 2026.11.17m). Docker started at
  17:29:37; the hook started `vcm-test-a` at 17:29:45 and `vcm-test-b` at 17:29:47 (the
  set delay of 2 seconds), while Unraid was still starting its own containers (done at
  17:30:09), so Unraid's start did not wait for it. Passed.
- PIM and keyfile through `cryptsetup` (KEY-2, SEC-1, 2026-11-17). `throwaway-pim` (a
  copy of `throwaway-ntfs`) given a PIM and the keyfile `throwaway-key` in VeraCrypt on
  Windows. `cryptsetup tcryptOpen --veracrypt --veracrypt-query-pim --key-file <path>
  --test-passphrase` (checks without unlocking), with the password and then the PIM as
  two lines on standard input: code 0. A wrong PIM and a missing keyfile: code 2 each.
  So the PIM never needs to be on a command line. Not tested yet: a keyfile without a
  password.
- Keyfiles, PIM and hidden volumes in the engine (KEY-2, KEY-3, VOL-3, version
  2026.11.17o). `vcmount mount --file <throwaway-pim> --name tw-pim --pim --keyfile
  <throwaway-key>`, password and PIM as two lines on standard input. A wrong PIM: code 2,
  "wrong password, PIM or keyfile". Without the keyfile: code 2. Right PIM and keyfile:
  mounted (ntfs3), then dismounted. A saved volume stores `keyfiles` (paths) and `pim`
  (only that it asks for one). Hidden volumes (`--tcrypt-hidden`) are built but not
  tested yet: no throwaway volume with a hidden volume exists.
- The same through the web page (2026-11-17, version 2026.11.17o, by the owner):
  `throwaway-pim` saved with its keyfile and "Ask for a PIM"; the mount dialog showed
  the keyfile and a PIM field, refused a wrong PIM and mounted with the right one;
  "Mount a file once" with keyfile and PIM mounted and dismounted; an ordinary volume
  mounted as before, without a PIM field. Passed.
- After the second security review (2026-11-26, Unraid 7.4.1, files copied with
  `scripts/deployweb.sh`, by the owner through "Mount a file once"): a keyfile
  `/boot/config/go` was refused with "A keyfile must be a file under /mnt/"; the right
  PIM mounted. The browser offered to save nothing and filled nothing into the PIM field
  (K6). Over plain HTTP with "Require HTTPS" on, the PIM field showed although the
  password field was hidden (Unraid's label style beat `hidden`): fixed in the style
  sheet. **A wrong, very large PIM (739184) found a bug:** cryptsetup ignores SIGTERM
  until its current key derivation ends (hours with that PIM), so the engine's 3-minute
  limit did not stop it, the page's 5-minute limit ended the engine instead, and
  cryptsetup ran on alone (ended by hand with the owner's OK). Fixed: `run()` now ends a
  program 5 seconds after asking it to stop. Retried with the fix: about 4 minutes later
  no cryptsetup was left on Bob.
- Cancel and busy (UI-8, 2026-11-26, Unraid 7.4.1, by the owner, PIM 739184 on
  `throwaway-pim`): Cancel during the unlock answered "Unlocking was cancelled" within
  a second, and the right PIM mounted straight after. A reload during an unlock, then
  a new mount: at once "Another volume is still being unlocked (for m:ss; it stops by
  itself within about m:ss)" with "Stop that unlock", which stopped it. (The first try
  showed a generic message: a garbled constant name made `vcmount busy` fail silently,
  which `php -l` does not catch; fixed.) Ctrl+C in Unraid's web terminal during
  `vcmount mount --file ... --pim --keyfile ...`: "Unlocking was cancelled". Afterwards
  no cryptsetup was left on Bob. Passed. A search of `/var/log` and `/tmp` for 739184 found it nowhere.
- Array stop and shutdown (audit S2, 2026-11-27, version 2026.11.27f installed from a
  local build, Unraid 7.4.1, shutdown time-out 120 s; all saved volumes throwaways):
  - During a slow unlock the engine held the lock file and cryptsetup did not (lock
    opened with close-on-exec). Passed.
  - `vcmount stop-dependents --all --within 5` stopped `vcm-test-a` and `vcm-test-b` in
    a second (code 0); with `--within 2` it left both running, "no time was left"
    (code 5), and a log line each. Passed.
  - Array stop by the owner with `throwaway-exfat` (two dependents) and
    `throwaway-400-xfs` mounted and a slow unlock (PIM 739184) running: the
    `stopping_docker` hook found the engine busy, cancelled the unlock (02:30:57) and
    stopped the dependents before Unraid stopped Docker (02:31:00); `unmounting_disks`
    dismounted both volumes (02:31:27) before Unraid unmounted the disks (02:31:31).
    The whole stop took about 75 s, mostly VMs (about 40 s) and containers (about
    20 s); the plugin added about 7 s. Passed. (The cancelled unlock was logged as
    "could not unlock"; it is now logged as "cancelled".)

**Engine tests (2026-11-15, all passed, on `throwaway-ntfs`, run with
`scripts/enginetest.sh`).**

- Wrong password: code 2, volume left locked, no loop device or mount folder left.
- Dismount while a program sits inside the volume: code 5, the program is named, the
  volume stays mounted; once the program is gone, dismount gives code 0.
- A mount that fails after unlocking (mount folder cannot be created): code 4, volume
  locked again. Not covered: the mount itself failing, which needs a dirty volume
  (test 7).
- Mount without saving: works, is listed as "(not saved)", writes no log line.
- `--read-only`: mounted read-only, creating a file is refused.
- `windows_names`: see FS-3.
- `dismount --all` (`scripts/enginetest.sh dismount-all`): code 0 with nothing mounted;
  code 5 while a program sits inside the volume, the program is named on screen and in
  the system log, the volume stays mounted; code 0 once the program is gone. Not
  covered: carrying on with other volumes after a busy one, which needs two test
  volumes mounted at once.

**Array-stop hook (2026-11-15, passed, on `throwaway-ntfs`).**

- Setup: the hook `event/unmounting_disks` and the engine were copied into a plugin
  folder in RAM with `scripts/deployhook.sh install`; `throwaway-ntfs` was mounted; the
  array was stopped with the Stop button.
- Result: after the stop the volume was dismounted and locked (no mount below
  `/mnt/addons`, no loop device left for the volume file). In the system log `/mnt/user`
  and `/mnt/disk5`, which holds the volume file, each unmounted at the first attempt,
  with no "target is busy" and no retry.
- This also shows that a plugin folder with only an `event` folder is enough for Unraid
  to call the hook, and that `unmounting_disks` runs before `/mnt/user` is unmounted.
- Bob's shutdown time-out is 120 seconds (`shutdownTimeout="120"` in
  `/var/local/emhttp/var.ini`), so the hook allows itself 60 seconds there.
- Not tested: a busy volume at array stop, and a real shutdown or reboot.

**Docker on Bob (2026-11-15, read only: `docker --version`, `/etc/rc.d/rc.docker`,
`docker images`).**

- Docker version 29.8.2.
- At array stop Unraid runs `docker stop` on all running containers with one time limit
  for all (`DOCKER_TIMEOUT` in `/boot/config/docker.cfg`, 10 seconds if not set) and
  kills what is left. The `stopping_docker` hook therefore has to stop the dependents
  first if they are to get their own grace period.
- Autostart is driven by the file `/var/lib/docker/unraid-autostart`, one container
  name per line with an optional wait (useful for DOC-7).
- The image `alpine:3.21` is already on Bob and can serve for a throwaway test
  container without a download.

**Docker control and forced dismount (2026-11-15, both passed, on `throwaway-ntfs` with
throwaway containers from `alpine:3.21`, run with `scripts/enginetest.sh`).**

- Case `dependents`: a volume with three dependents, one of which does not exist.
  Mount: code 7, the two real containers started, the missing one named.
  `stop-dependents --all`: the container that obeys the stop signal stopped by itself,
  the one that ignores it was killed after its grace period of 5 seconds, the volume
  stayed mounted. Dismount: the same, then the volume was locked. The kill is in the
  system log.
- Case `force`: with a program sitting inside the volume, a plain dismount gave code 5.
  `dismount --force` then ended the program, stopped a container that had been given the
  volume's folder and was not a dependent, and locked the volume. No loop device left.
- This confirms the two assumptions of the forced dismount: a container that has a
  folder of the volume keeps it from being locked after the dismount on the server
  itself, and the engine finds that container through its processes.
- Not covered: whether the notifications arrived in Unraid (to be looked at in the web
  UI), the two hooks at a real array stop, a busy volume at array stop, a dependent
  whose start fails for a reason other than "does not exist".

**Both hooks at a real array stop with a busy volume (2026-11-16, passed, on
`throwaway-ntfs` with throwaway containers from `alpine:3.21`, run with the cases
`stop-prepare`, `stop-check` and `stop-cleanup` of `scripts/enginetest.sh`).**

- Setup: both hooks, the engine and the test configuration were copied into a plugin
  folder in RAM with `scripts/deployhook.sh install`. The volume was mounted with two
  running dependents, one of which ignores the stop signal, and a program sat inside the
  volume. The array was stopped with the Stop button.
- `stopping_docker`: the stubborn dependent was killed after its grace period of 5
  seconds, before Unraid stopped Docker itself.
- `unmounting_disks`: 38 seconds later the dismount was forced, the program was ended,
  and two seconds after that the volume was dismounted and locked. No loop device left.
  The forced dismount therefore works while Docker is already stopped.
- No "busy" line in the system log during the stop.
- The hooks have no configuration of their own to read during development, because the
  flash drive is not written. For tests they make the engine read a file
  `volumes.dev.json` next to it, if there is one. The package never contains that file.
- Not covered: that the obedient dependent stopped by itself (Docker is off while the
  array is stopped, and the engine only logs kills), whether the notifications arrived
  in Unraid, and a real shutdown or reboot. The last is deferred until the plugin
  installs as a package: the hooks live in RAM and a reboot wipes them.

## 11. Later

- Key sources: network-fetched key; TPM-sealed secret.
- Encrypted partitions and USB drives.
- NFS export with an explicit host list.
- Compose `up`/`down` through Compose Manager.
- Publishing: public repository, Community Apps listing, support thread, translations.

## 12. Decision log

| Date | Decision |
| --- | --- |
| 2026-11-15 | Native approach with `cryptsetup`; no VeraCrypt binary. |
| 2026-11-15 | Repository `bentrop/unraid-veracrypt-mount`, private for now. |
| 2026-11-15 | Default key source: ask every time; automount only as explicit opt-in. |
| 2026-11-15 | Hidden volumes: access, plus optional "mount without saving". |
| 2026-11-15 | Per-volume read-only switch as the hidden-volume safeguard. |
| 2026-11-15 | Own mount point and share by default; mounting inside a share as an option. |
| 2026-11-15 | No NFS in version 1. |
| 2026-11-15 | Appdata inside the volume: optional, default off. |
| 2026-11-15 | Templates and Compose stacks both supported. |
| 2026-11-15 | Container files only in version 1. |
| 2026-11-15 | HTTP allowed with a warning; "require HTTPS" setting. |
| 2026-11-17 | Security review of the password path (`docs/REVIEW-secrets.md`): P1, H1, H2, H6 and H7 fixed, H4 and H5 documented under PRIV-4, H3 fixed the same day: the development switch (`volumes.dev.json`) sits between `dev-only` markers in the two hooks and `action.php`, `scripts/build.py` leaves those lines out of the package and refuses to build if the file name still appears; the Main page condition reads only the real settings file. "Require HTTPS" now on by default (UI-5). |
| 2026-11-15 | Development access to the server over SSH: ask every time (see `CLAUDE.md`). |
| 2026-11-15 | Borrow the layout of `dkaser/unraid-plugin-template`; do not copy it wholesale. |
| 2026-11-15 | Own small build script; the same script runs locally and later in GitHub Actions. |
| 2026-11-15 | Release workflow, when added: only GitHub's own actions, pinned to fixed versions. |
| 2026-11-15 | Licence: MIT. |
| 2026-11-15 | LIFE-6 agreed: update or removal with volumes mounted is refused, not auto-dismounted. |
| 2026-11-15 | Engine design agreed (`docs/DESIGN-engine.md`, decisions D1 to D8): PHP, command `vcmount`, plugin ID `veracrypt.mount`, JSON configuration on the flash drive. |
| 2026-11-15 | VOL-7, FS-3, FS-4, LIFE-7 and CLI-1 to CLI-3 agreed. Ownership of files created on Bob accepted for version 1. |
| 2026-11-15 | Mockup review: volume list under Settings (User Utilities); section on Main only as an option, off by default. |
| 2026-11-15 | SEC-5 dropped: no added waiting time after a wrong password. |
| 2026-11-15 | VOL-6, SHR-2, DOC-3 to DOC-6, LIFE-3, LIFE-8, LIFE-9, UI-3, UI-4 and PRIV-3 agreed. LIFE-4 is still proposed. |
| 2026-11-15 | DOC-5 changed: a dependent that does not stop within its grace period is killed and the dismount continues. Dismounting the volume comes before a clean stop of a dependent. |
| 2026-11-15 | DOC-3: a dependent that fails to start does not hold back the others; notification; engine result code 7. |
| 2026-11-15 | LIFE-5 changed and LIFE-10 added: explicit force option for a busy dismount (end the holders, then dismount normally; never lazy). Force is on at array stop, shutdown and reboot, with a setting to turn it off. |
| 2026-11-15 | Time at array stop: up to 60 seconds for stopping dependents (`stopping_docker`), up to 30 for dismounting (`unmounting_disks`). |
| 2026-11-15 | Docker control starts with single containers; Compose stacks follow as a later step. |
| 2026-11-16 | SMB sharing design agreed (one file per share, include line in `smb-unassigned.conf`). Web interface design agreed (`docs/DESIGN-ui.md`), with U1 to U4. |
| 2026-11-16 | Step 3 of the web interface: shares only with Unraid's "Private" security, per user (SHR-1); dependents reordered by drag and drop as on Unraid's Docker page; a mounted volume cannot be renamed or removed (D3); saving checks the revision so a change in another tab is not overwritten. PRIV-3 extended: ready-to-copy File Activity exclusions. |
| 2026-11-27 | Default grace period of a new dependent lowered from 60 to 10 seconds, as Docker's own `docker stop`; a dependent that needs longer is killed and reported, so it can be raised. DOC-7 built; DOC-6 later. |
