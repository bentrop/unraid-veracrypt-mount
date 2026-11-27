# Security review: the path of the volume password

- **Date:** 2026-11-17
- **Reviewer:** Claude, in a separate session that wrote none of the code (SEC-9).
- **Method:** reading the code only. Nothing was run, the server was not contacted,
  `.secrets/` was not opened, no file other than this report was changed.
- **Scope:** the volume password from the browser field to `cryptsetup`, as listed in
  the task: `include/dialog.php`, the mount dialog in `js/vcmount.js`,
  `include/action.php`, `include/actions.php`, the mount path of `scripts/vcmount`, and
  `/usr/local/sbin/vcmount`. Checked against SPEC section 6 (SEC-1 to SEC-9),
  section 7 (PRIV-1, PRIV-2) and DESIGN-ui section 4. The rest of the plugin (Docker
  control, shares, saving settings, installation) was **not** reviewed.
- **State reviewed:** the working folder on top of commit `9a7a490`. The files in scope
  had no uncommitted changes.

## 1. Summary

**Is the password path sound? Yes, with one real problem to fix before first real use.**

Why yes: the code does what the design says. The password exists in exactly one
request, is handed to the engine through *standard input* (the channel a program reads
typed input from, invisible to other programs), and the engine never reads it; it
passes that channel to `cryptsetup` untouched. I found no place where the password is
put into a command line, an environment variable, a file, a log line, a notification
or an error message. No program is started through a *shell* (a command interpreter
that could misread input as a command). Log lines contain only a volume name and a
fixed reason, and volumes mounted "once" are not logged at all.

The one real problem (finding P1): with the setting "require HTTPS" switched on, a
mount from a page opened over plain HTTP is refused, but only **after** the browser has
already sent the password unencrypted. The setting stops the mount, not the leak.

The rest are hardening ideas: none is a leak today, each closes a way a future mistake
or an unusual situation could become one.

| SPEC item | Result |
|---|---|
| SEC-1 secrets only via standard input | Met in the code. See H2 for a remaining edge. |
| SEC-2 CSRF token on every changing request | Met by Unraid itself; confirm on Bob (open check 1). |
| SEC-3 no user input in a shell command | Met. Both PHP layers start programs from argument lists. |
| SEC-4 nothing secret in the configuration | Met for the password path (it is never written). |
| SEC-7 never opens a volume it was not asked to | Met in the mount path. |
| PRIV-1 log holds events only | Met. |
| PRIV-2 nothing identifying logged for "mount once" | Met for the plugin's own log. See H4, H5. |
| DESIGN-ui section 4 | Matches the code, except its sentence on HTTPS (P1). |

## 2. Real problems

### P1. "Require HTTPS" refuses the mount only after the password was sent in the clear

- **Where:** `js/vcmount.js` lines 392 and 480-508 (the dialog only shows a warning
  and then sends); `include/actions.php` lines 84-87 (adds `--over-http`);
  `scripts/vcmount` line 1218 (the refusal).
- **What could go wrong:** You switch "require HTTPS" on to be safe. Later the page is
  opened over plain HTTP (an old bookmark, typing the address without `https://`).
  You enter the password and press Mount. The browser sends it unencrypted, and only
  then does the server answer "Refused". Anyone able to listen on that network has
  the password, although the setting promised otherwise.
- **How likely:** every time the page is used over HTTP with the setting on. How
  often that happens depends on how the page is opened; if Unraid itself is set to
  redirect HTTP to HTTPS it cannot happen (open check 3).
- **How bad:** medium. It needs a listener on the home network at that moment, but
  what leaks is the volume password itself.
- **Suggested fix:** let the page know the setting (for example as a field in the
  `list` answer) and, when it is on and the page is on HTTP, do not offer the password
  field at all: show "Open this page over HTTPS to unlock" with a link. Keep the
  server-side check as the second line of defence. Also correct DESIGN-ui section 4,
  point 2, so it says what the server check can and cannot do.
- **Related, by design:** the setting is off by default (`scripts/vcmount` line 67).
  With it off, a password over HTTP is accepted after a visible warning. That is
  what the spec agreed (UI-5); it is listed here only so the choice is a conscious one.

## 3. Hardening ideas

Ordered by value. None is a leak today.

### H1. The password form has no safe fallback if the page script fails

- **Where:** `include/dialog.php` line 12 (`<form ...>` without `method` or `action`);
  the script takes over the form in `js/vcmount.js` line 949.
- **What could go wrong:** a form without `method` is sent by the browser as a "GET"
  request, which puts all fields **into the address**: `...?username=...&password=...`.
  Normally the script intercepts the form and this never happens. But the Mount
  buttons are wired up (line 927) before the form is (line 949); if the script ever
  stopped between the two, for example after an Unraid update, the dialog would open
  and pressing Mount would put the password into the address bar and the browser's
  history.
- **How likely:** very unlikely. **How bad:** high if it happens (password stored in
  the browser history in readable form; the web server's access log is off, so not
  there).
- **Suggested fix:** one line: give the form `method="post"` and a harmless `action`,
  so even the fallback never uses the address. Optionally wire up the form first.

### H2. A PHP crash report could contain the first 15 characters of the password

- **Where:** `include/actions.php` lines 39 and 150 (`vcm_handle($post, ...)` and
  `vcm_run(..., $stdin)` receive the password as a function argument);
  `include/action.php` line 42.
- **What could go wrong:** when PHP code fails with an unexpected error, PHP writes a
  *stack trace* (the list of functions that were running) to its error log, and by
  default that list shows the start of each text argument, up to 15 characters. The
  password is such an argument. I found no input that triggers such an error today,
  so this is about a future bug, not a present one.
- **How likely:** low. **How bad:** medium-high: part of the password in a log, which
  SEC-1 forbids.
- **Suggested fix:** mark the two parameters with PHP's `#[\SensitiveParameter]`
  (available from PHP 8.2; it makes PHP print a placeholder instead of the value),
  and wrap the call in `action.php` in a catch-all that returns a fixed error
  message. Open check 2 says what to look at on Bob.

### H3. Development switch still active in the shipped code

- **Where:** `include/action.php` lines 27-34 (and the two event hooks).
- **What could go wrong:** if a file `volumes.dev.json` lies next to the engine, the
  plugin uses it instead of the real settings. A changed settings file could point a
  known volume name at a different file or mount location. Only root can create that
  file, and root can do anything anyway, so this is not a hole; it is a surprise
  waiting in a release. The build already refuses to package the file itself.
- **How likely:** low. **How bad:** low.
- **Suggested fix:** before the first release, remove the switch from the packaged
  files, or have the build strip it.

### H4. "Mount once" over SSH leaves the file path in the shell history

- **Where:** `scripts/vcmount` lines 86 and 1178-1197; `/usr/local/sbin/vcmount`.
- **What could go wrong:** `vcmount mount --file /path/to/volume --name x` typed over
  SSH is remembered by the shell in root's command history, and is visible in the
  process list while it runs. The plugin logs nothing (PRIV-2 is met for its own
  log), but the path, which is identifying, is kept elsewhere. On Unraid that
  history lives in RAM and is gone after a reboot. The password itself is never part
  of the command.
- **How likely:** certain when used that way. **How bad:** low.
- **Suggested fix:** state it in the documentation (PRIV-4 collects such limits), with
  the tip to use the web page for volumes that must leave no trace.

### H5. The browser may still offer to save a "mount once" password

- **Where:** `include/dialog.php` line 22; `js/vcmount.js` line 390.
- **What could go wrong:** for "mount once" the script sets `autocomplete="off"`.
  Browsers commonly ignore that on password fields and may still ask "Save
  password?". Saying yes would store the password, though without the file path.
- **How likely:** depends on the browser. **How bad:** low; it needs your own click.
- **Suggested fix:** document it. Test in the browsers you use (open check 5).

### H6. Piping a password into `vcmount` by hand

- **Where:** `scripts/vcmount` line 110 (help text), line 1116.
- **What could go wrong:** typed normally, `vcmount mount <name>` makes `cryptsetup`
  ask for the password without showing it. That is safe. But the help text says the
  password is "read from standard input", which may tempt someone to type
  `echo 'password' | vcmount mount x`. That would put the password in the shell
  history and briefly in the process list.
- **How likely:** low. **How bad:** medium for whoever does it.
- **Suggested fix:** one sentence in the help text: "Just run the command; you will be
  asked for the password. Do not put it on the command line."

### H7. Smaller notes

- `include/actions.php` line 27 accepts passwords up to 1024 bytes; VeraCrypt allows
  at most 128 characters. A longer one simply fails as "wrong password". Harmless;
  setting the limit to 128 gives a clearer message.
- The HTTPS check trusts what Unraid's web server reports. If the page were reached
  through a *reverse proxy* (a second web server in front), PHP sees only the last
  leg of the journey, so the check could be wrong in either direction. Not relevant
  unless such a proxy is used; worth a line in the documentation.

## 4. What I checked and found in order

- **Browser.** Real password field; the field is emptied in the same step that reads
  it (`vcmount.js` 491-492); the password is sent once, in the body of a POST
  request, and the script's own copy is dropped (507). On a wrong password the field
  stays empty. After a lost answer the script asks only "is something running?" and
  "is it mounted?" (`settle`, 457-478); it never sends the password a second time and
  does not keep it. Nothing is written to browser storage or the console. Error texts
  are shown as plain text, so they cannot inject markup.
- **CSRF** (the token that proves a request comes from Unraid's own page): sent with
  every request (`vcmount.js` 43); checked by Unraid before `action.php` runs;
  `action.php` refuses everything that is not a POST (16-20).
- **Web request.** The action must be on a fixed list; the volume name must match a
  strict pattern; the password must be non-empty text without line breaks. The engine
  is started from a list of arguments without a shell (`actions.php` 152-160). The
  password is written to the engine's standard input only (165). The engine's error
  output is thrown away (158), and the answer is never cached (`action.php` 14).
  Refusal messages are fixed texts.
- **Engine.** In the mount path the engine never reads its standard input; only
  `cryptsetup` gets it (`vcmount` 1116). Every other program it starts gets an empty
  input (567). If a mount is refused before `cryptsetup` starts, the unread password
  disappears when the engine ends. Error messages name the volume, file or mount
  location, never input from the password channel.
- **Logging and notifications.** Every log line in the mount and dismount path is a
  fixed text plus the volume name (and a dependent's name). Names are restricted to
  letters, digits, `-` and `_`, so a name cannot forge a log line. For "mount once"
  every log call is skipped (`vcmount` 1226, 1238, and the dismount path). Volume
  notifications use the same texts.
- **SSH command.** `/usr/local/sbin/vcmount` only hands over to the engine with the
  arguments unchanged and safely quoted.
- **Test scripts** (looked at only for how they pass the secret): they feed the
  password file into standard input and never put it on a command line.

## 5. What I could not verify (open checks on the server)

These need a look at Bob, which this review was not allowed to do. All are read-only.

1. **CSRF and login protection.** Confirm that a POST to
   `/plugins/veracrypt.mount/include/action.php` without a token, and one without
   being logged in, are both rejected by Unraid before the plugin's code runs.
2. **PHP error reporting (for H2).** PHP version, the value of
   `zend.exception_ignore_args`, and where PHP errors are written (`log_errors`,
   `error_log`, `display_errors` in `/etc/php.ini` and `/etc/php-fpm.d/`).
3. **HTTP-to-HTTPS redirect (for P1).** Whether Bob's web interface redirects plain
   HTTP to HTTPS (Settings, Management Access, "Use SSL/TLS"). If it always does, P1
   cannot occur on Bob, though it still can for other users of the plugin.
4. **`cryptsetup` behaviour.** That version 2.8.8 reads a piped password up to the
   first line break and never prints it, also on errors. The code relies on this.
   (`scripts/logcheck.sh` appears to test that the password is absent from the logs;
   I did not run it.)
5. **Browsers.** Whether your browsers offer to save the password after "mount once",
   and that a saved entry for a normal volume is stored under `veracrypt:<name>`.
6. **Kernel messages.** Whether mounting writes lines to the system log on its own
   (the NTFS or exFAT driver, the device mapper) that would identify a "mount once"
   volume. The plugin cannot stop the kernel from logging; if it does, it belongs in
   the PRIV-4 documentation.
7. **The Dashboard.** That the mount dialog is not placed inside another form on the
   Dashboard or Main page, which could change how the browser sends it (see H1).

## 6. Limits that cannot be removed

Stated so they are known, not as findings. They match DESIGN-ui section 4.

- During a mount the password is in the memory of the browser and of the web
  server's PHP process. Neither JavaScript nor PHP can reliably wipe memory; the code
  drops its references as early as it can.
- A program running as root on the server during the mount could read it. Root can
  read everything.
- This review covers the password only. PIM, keyfiles and hidden volumes are not
  built yet (`vcmount` line 1213 refuses hidden volumes); when they are, their path
  needs the same review.

## 7. Follow-up (2026-11-17)

Fixed in version 2026.11.17 to 2026.11.17b (see the commit history and SPEC, decision
log 2026-11-17):

- **P1** fixed: with "require HTTPS" on, a page opened over plain HTTP offers no
  password field, only a link to HTTPS; the page and the submit function refuse to
  send, and the server check stays. "Require HTTPS" is now on by default. Browser test
  passed.
- **H1** fixed: the form has `method="post"`, `action="about:blank"` and an inline
  `onsubmit="return false"`, and is wired up first.
- **H2** fixed: `#[\SensitiveParameter]` on both PHP parameters that carry the
  password; `action.php` answers unexpected errors with a fixed text.
- **H3** fixed: the development switch sits between `dev-only` markers and is left
  out of the package by `scripts/build.py`, which refuses to build if it remains.
- **H4, H5** documented under PRIV-4. **H6** fixed in the help text. **H7**: 128
  character limit; the reverse proxy note is in DESIGN-ui section 4.

Open checks of section 5, done on Bob the same day (read-only, test volumes only):

1. **CSRF and login: passed.** Unraid's `local_prepend.php` checks the token on every
   POST before any plugin code runs (403 when missing or wrong, `hash_equals`). A POST
   without login is redirected to `/login`.
2. **PHP errors: H2 was a real risk.** `error_log = syslog` and
   `zend.exception_ignore_args = 0`, so a stack trace with arguments would have reached
   the system log, which Unraid also copies to the flash at shutdown. Closed by the H2
   fix.
3. **HTTP to HTTPS: not redirected on Bob.** The P1 case can occur there; closed by the
   P1 fix and the new default.
4. **cryptsetup and a wrong password: passed.** After a mount with a wrong and one with
   the right password, `scripts/logcheck.sh` found the password nowhere under
   `/var/log` or `/tmp`.
5. **Browser save prompt after "mount once": passed in the owner's browser.** No offer
   to save the password. Not because of plain HTTP (browsers generally still offer to
   save there, they only refuse to fill in), but most likely because the field is
   marked "do not save", is emptied the moment Mount is clicked, and the page sends in
   the background without loading a new page, the moment browsers usually ask. Side
   effect for normal volumes (UI-4): a password manager can still fill the dialog, but
   may not offer to save a new entry by itself; add it once by hand.
6. **Kernel messages after "mount once": passed.** The system log names neither the
   volume name nor the file path. The kernel logs only the size of the loop device
   (`loop3: detected capacity change from 0 to 102400`).
7. **Form nesting on Dashboard and Main: passed.** No form on those pages encloses the
   dialog; every form there closes within its own section.

## 8. Second review: PIM, keyfiles and hidden volumes (commit fda9b63)

- **Date:** 2026-11-17
- **Reviewer:** Claude, in a separate session that wrote none of this code (SEC-9).
- **Method:** reading the code only. Nothing was run, the server was not contacted,
  `.secrets/` was not opened, no code was changed. Only this section was added.
- **Scope:** the PIM and keyfile path from the browser to `cryptsetup`:
  `include/actions.php` (cases `mount` and `mount-once`), `include/action.php`,
  `include/dialog.php`, `submitMount` and `openDialog` in `js/vcmount.js`, and in
  `scripts/vcmount` the functions `parse_args`, `read_keyfiles`, `check_keyfiles`,
  `do_mount` and `command_mount`. Read as the diff of fda9b63 and as the current files.
  Sections 1 to 7 were not redone where this commit did not touch the code.

### 8.1 Summary

**Is the PIM path sound? Yes. Is the keyfile path sound? Yes for secrecy, with weaknesses
that are not leaks.**

- **The PIM never reaches a command line, an environment variable, a file, a log, a
  notification or the configuration (SEC-1 met).** In the browser it lives in one field,
  is cleared in the same step it is read, and is sent once in the POST body together with
  the password. In PHP it is checked as digits only, joined to the password into one
  string, and written to the engine's standard input. The engine never reads that input
  and hands it to `cryptsetup`, which takes the PIM from the second line. On the engine's
  command line there is only the bare word `--pim`, and in the configuration only the
  fact `"pim": true`. Error texts never repeat the PIM.
- **Keyfile contents never reach this program.** Only `cryptsetup` reads them. Only the
  paths are stored, passed and shown, and a path is not a secret (SPEC KEY-3). Paths are
  shown in the page only as text (`.text()`, `.attr()`), so they cannot inject markup.
- **No finding is a leak of a password, PIM or keyfile content today.** The ones that
  matter most (K1 to K3) are about what a keyfile path can be made to touch, what the
  stored paths tell a thief, and a help text that invites a leak.

| SPEC item | Result |
|---|---|
| SEC-1 no PIM or key content in arguments, environment, files, logs, notifications, configuration | Met. See K3 and K5 for edges around it. |
| SEC-3 no user input in a shell command; paths validated and resolved | Met for shell use. Resolved yes; limited to a safe area no (K1). |
| SEC-4 nothing secret in the configuration | Met. It holds keyfile paths and the flags `pim` and `hidden`, see K2. |
| SEC-7 never opens what it was not asked to | Met for volumes. Keyfile paths are not limited (K1). |
| PRIV-2 "mount once" leaves nothing identifying | Met for the plugin's log. The keyfile path joins the file path in the process list (K5). |

### 8.2 Findings, most severe first

No finding is rated high. None blocks a release for secrecy's sake; K1 to K3 are worth
doing before the keyfile feature is advertised.

#### K1. Medium-low: a keyfile path may point anywhere, including files that block or are not keyfiles

- **Where:** `actions.php` (`mount-once`, the `keyfiles` loop: only "starts with `/`, at
  most 4096 bytes, no control characters"); `scripts/vcmount` `read_keyfiles` (same
  rules) and `check_keyfiles` (`realpath`, `is_file`, `is_readable`, not the volume file).
  The picker in the page starts at `/mnt/`, but the server does not enforce that.
- **What could go wrong:**
  1. *Existence oracle.* The message "The keyfile <path> does not exist or cannot be
     read" against a different outcome for a readable file tells a user of the page
     whether any path on the server exists as a readable regular file (for example under
     `/boot` or `/root`). The content stays hidden; only existence leaks. The page is
     reachable only after Unraid's login and with the CSRF token, and that user is
     effectively root anyway, so this is low.
  2. *Blocking files.* `is_file` is true for many files in `/proc` and `/sys` that never
     end or block when read (for example `/proc/kmsg`). `cryptsetup` would then wait
     until the engine's `UNLOCK_TIMEOUT` stops it, while the engine holds its lock, so
     mounts and dismounts of other volumes wait too. Whether `cryptsetup` stops reading
     such a file early was **not verified**.
  3. *Swap after the check.* `check_keyfiles` resolves the path and `cryptsetup` opens
     the resolved path a moment later. Whoever can replace the file in that moment (needs
     write access to its folder, so another local user) changes which file is used. No
     secret leaks; the unlock merely fails or uses another file. Accepted.
- **How likely:** low; needs a logged-in user acting against their own server.
- **Suggested fix:** SEC-3 says paths are "validated and resolved before use". Make the
  check say where a keyfile may be: after `realpath`, require the result to be below
  `/mnt/` (where removable drives, shares and disks are), and refuse everything else.
  Give one message for "does not exist", "cannot be read" and "not allowed here" so the
  answer is not an oracle. Apply the same rule to `--file` in a later change.

#### K2. Medium-low: stored keyfile paths and the hidden flag describe the volume's protection to anyone who gets the flash backup

- **Where:** `volume_for_file` (writes `keyfiles`, `pim`, `hidden` into `volumes.json` on
  the flash); `describe` (the `list` answer includes them); the mount dialog
  (`#vcm-keyfile-note`: "Keyfile: /mnt/..., Opens the hidden volume").
- **What could go wrong:**
  1. A volume that needs **only** a keyfile (password empty) and whose keyfile is on the
     same server (the path is under `/mnt/user` or `/mnt/disk*`) is, to anyone holding the
     flash backup (which Unraid copies, also to the cloud with Unraid Connect, KEY-5) and
     the array disks, unlockable without knowing anything. The configuration names
     exactly which file to use. Against that thief the volume is no better protected than
     an unencrypted one. Nothing in the page says so.
  2. A saved volume with `"hidden": true` states in plain text that the file contains a
     hidden volume. That removes the *plausible deniability* (being able to claim there is
     no hidden volume) that VeraCrypt's hidden volumes are built for. "Mount a file once"
     does not have this problem, because it saves nothing (PRIV-2).
- **How likely:** (1) depends on how people choose keyfiles; (2) certain whenever the
  "hidden" box is ticked on a saved volume. **How bad:** medium for the owner's intent,
  zero for the password path.
- **Suggested fix:** (1) in the edit panel, when a keyfile lies on the array and the
  volume has no other secret, say in one sentence what a keyfile on the same server does
  and does not protect against (KEY-4 asks for exactly this kind of wording). (2) next to
  the "hidden volume" switch: "A saved volume records that it contains a hidden volume.
  Use *Mount a file once* if nobody should be able to tell." Both are text changes.

#### K3. Low-medium: the help text now invites piping a password and PIM into the command (H6 again)

- **Where:** `scripts/vcmount`, help text added by fda9b63: "The password is read from the
  terminal or standard input ... on standard input it is the line after the password."
- **What could go wrong:** review H6 removed the invitation to `echo password | vcmount`.
  This text describes piping again, now for two secrets. Someone reading it types
  `printf` or `echo` with the password and PIM piped into `vcmount mount ...` over SSH,
  and both land in root's shell history and briefly in the process list (RAM only, gone at
  reboot, but readable by root meanwhile).
- **How likely:** low. **How bad:** medium for whoever does it.
- **Suggested fix:** replace the sentence with "Just run the command; you are asked for
  the password and, if needed, the PIM. Do not put them on the command line or pipe them
  in." How the web page uses standard input belongs in DESIGN-engine, not in the help.

#### K4. Low: the server does not enforce what the page asks for (PIM required, empty password)

- **Where:** `actions.php` `mount`: `no_password=1` lifts the "Enter the password" check
  for **any** `mount` of a saved volume; the "keyfile required" rule
  (`$password === '' && $keyfiles === []`) sits only in the `mount-once` branch. "Enter
  the PIM" for a saved volume that has one is checked only in the page.
- **What could go wrong:** a request that is not from the page (or a stale page) can send
  an empty password for a saved volume without keyfiles; the engine hands an empty line
  to `cryptsetup`, which fails as "wrong password". A saved volume that asks for a PIM can
  be sent no PIM: `cryptsetup` then finds the end of its input where the second line
  should be; the outcome was not tested. In the other direction, a PIM sent for a volume
  that does not ask for one is written to standard input but never read, and silently
  ignored. None of this leaks anything; the first is a failed attempt, the others give
  confusing answers.
- **Suggested fix:** let the engine, which knows the saved volume, refuse with a clear
  message ("this volume needs a PIM", "needs a password") before it starts `cryptsetup`,
  and let PHP accept `no_password` only together with keyfiles.

#### K5. Low: keyfile paths are on the command lines while a "mount once" runs

- **Where:** `actions.php` (`--keyfile <path>` in the engine's arguments); `do_mount`
  (`--key-file <path>` in the `cryptsetup` arguments).
- **What could go wrong:** `ps` or `/proc/<pid>/cmdline` shows the path to anyone who can
  list processes, for as long as the engine runs. The same holds already for the volume
  file path (review H4). Over SSH, `vcmount mount --file ... --keyfile ...` also stays in
  root's shell history. The plugin's log stays empty (PRIV-2 met for the log). SEC-1 is
  not broken: a path is not a secret.
- **Suggested fix:** document it with H4 under PRIV-4: "the paths of the volume file and
  keyfiles are visible in the process list while mounting".

#### K6. Low: the PIM field may confuse password managers (browser check needed)

- **Where:** `dialog.php` (`#vcm-pim` is `type="password"` next to `#vcm-password` in the
  same form, `autocomplete="off"`).
- **What could go wrong:** two password fields in one form look to many browsers like a
  "current and new password" pair. The browser may offer to fill the stored password into
  the PIM field or to save the PIM as the password. Section 7, check 5 passed with **one**
  field and was not repeated for two. A password filled into the PIM field is rejected by
  the page's own check (digits only) and never sent, so the worst case is a wrong entry in
  the user's own password manager.
- **Suggested fix:** open check 1 below. If it misbehaves, use
  `autocomplete="one-time-code"` or a text field masked with CSS instead of
  `type="password"`.

#### K7. Informational

- The mismatch message "wrong password, PIM or keyfile" is good: it does not say which
  part is wrong. It names only what the request or the saved volume already uses.
- "no hidden volume inside" appears only when the request asked for the hidden volume,
  so it reveals nothing about a volume opened as an ordinary one.
- A hidden volume opened without hidden-volume protection can be damaged by writing to
  the outer volume (VOL-4, documented; the read-only switch is the safeguard).
- KEY-3's automatic mount of a volume whose keyfile is present at array start is **not
  built yet** (no such path was found in `scripts/vcmount`). When it is, it needs its own
  review: standard input must be empty, volumes that need a password or a PIM must be
  excluded, and a log line for a failed attempt must not contain the keyfile path.
- Whether `cryptsetup` shows the PIM while it is typed on a terminal was **not
  verified**; it should not.

### 8.3 What I checked and found in order

- **Browser, `submitMount` and `openDialog`.** The PIM is read once, trimmed, matched
  against `^[1-9][0-9]{0,8}$`, put into the request data and the field emptied at once;
  the script's copies are set to `null` after the request is started (as for the
  password). Validation errors return **before** anything is sent, with fixed texts that
  do not repeat the value. `openDialog` and `closeDialog` clear both fields, so a PIM does
  not survive a cancel or a wrong answer. After a lost answer `settle` still asks only
  "is something running?"; the PIM is never sent twice. Nothing is written to browser
  storage or the console (no `console.*`, `localStorage` or `sessionStorage` in the
  file). Keyfile paths appear only through `.text()` and `.attr()`; the error line uses
  `.text()`; the info dialog uses `esc()`.
- **`dialog.php`.** The PIM field has no `name`, so even the H1 fallback (a plain form
  submit, now `method="post"` to `about:blank`) would not carry it. The keyfile fields
  have no `name` either. `required` was removed from the password field; the empty case is
  handled in the script and, for "mount once", on the server.
- **`actions.php`.** `pim` must be a string of digits (`\A...\z`, so no trailing line
  break): the PIM cannot add an input line. The password check for NUL, CR and LF still
  runs before the join, so the password cannot contain the line break that would split
  the two. `$password` and `$pim` are unset after the join, and the joined string goes
  on as `#[\SensitiveParameter]`; `vcm_handle` still marks `$post` (and so the PIM)
  sensitive. Non-string keyfile entries, nested arrays and more than 8 entries are
  refused. `keyfiles`, `hidden` and `pim` are ignored for a saved volume (it uses its
  stored settings). The engine is still started from a list of arguments without a shell,
  and its error output is still discarded.
- **`scripts/vcmount`.** `--pim` and `--hidden` are flags; `--keyfile` takes the next
  argument as a value. A value that starts with `--` is taken as a path and then fails the
  "starts with `/`" rule. Keyfile paths follow `--key-file` as separate arguments, after
  `realpath`, so a path cannot become an option; no argument list is built from a string
  and no shell runs. `cryptsetup` gets the engine's standard input and the engine reads
  none of it; every other program started by the engine gets `/dev/null`. In the mount
  path no `log_event` or notification contains a PIM or a keyfile path, and for "mount
  once" nothing is logged. `describe` publishes keyfile paths and the *fact* of a PIM,
  never a PIM. The unlock error is built from fixed words.
- **Configuration.** `volume_for_file` writes `pim: true` and `keyfiles` (paths) only;
  `read_keyfiles` limits the count (8), length (4096) and characters of stored paths and
  removes duplicates. The plugin never reads a keyfile's content. SEC-4 holds.
- **Tests recorded in SPEC section 10.** PIM and keyfile through standard input and
  `--key-file` as described; a wrong PIM and a missing keyfile gave code 2 with the
  generic message. Not tested yet: a keyfile without a password (the page and PHP now
  allow an empty password there, handing an empty first line to `cryptsetup`) and a
  hidden volume.

### 8.4 What I could not verify (open checks; read-only or on throwaway volumes)

1. **Browser (K6).** On the owner's browser and password manager: does the dialog still
   offer nothing to save after a mount with a PIM, and is a stored password not filled
   into the PIM field?
2. **Keyfile without a password.** Does an empty first line on standard input unlock a
   volume that has only a keyfile, and what happens with no input at all? With a PIM and
   no password the input is an empty line followed by the PIM.
3. **Blocking keyfile (K1).** Whether `cryptsetup` returns for a keyfile such as
   `/proc/kmsg` or only at the engine's time limit. Needs the owner's go-ahead: it holds
   the engine lock for that time.
4. **Logs.** Repeat `scripts/logcheck.sh` after one mount **with a PIM** (right and wrong
   one), to show it is nowhere under `/var/log` and `/tmp`, as was done for the password.
5. **`cryptsetup` and the PIM.** That 2.8.8 never prints the PIM, also on errors (the
   recorded tests covered success and the exit code for a wrong PIM only).
6. **Hidden volume.** Not testable until a throwaway volume with a hidden volume exists;
   `--tcrypt-hidden` and its error text were only read.

### 8.5 Recommendation

The secret path for PIM and keyfiles is sound and can be released once checks 1 and 4
of section 8.4 pass. Before that, do the two text changes (K2, K3), which cost nothing,
and decide on K1 (the folder limit for keyfiles), the only one that touches code. K4 to
K6 can follow in a later version.

### 8.6 Follow-up (same day)

- **K1 fixed:** keyfiles must lie under `/mnt/`, checked on the stored path, in PHP,
  in the page and after `realpath` in the engine. Every refusal gives the same message.
- **K2 fixed (text):** the edit panel says what a keyfile on the same server does not
  protect against, and that a saved volume reveals its hidden volume; the README says
  the same.
- **K3 fixed:** the help no longer describes standard input; it says you are asked.
- **K5 documented** under PRIV-4 and in the README.
- **K4 open** for a later version.
- **Checks of section 8.4, 2026-11-26:** 1 (browser, K6) passed: nothing offered to
  save, nothing filled into the PIM field. 4 (logs) passed for a PIM typed into the page:
  a wrong PIM, 739184, appears nowhere under `/var/log` and `/tmp`. 3 (blocking work)
  showed a related fault: cryptsetup does not stop on SIGTERM during a long key
  derivation, so a time limit did not end it; the engine now ends it 5 seconds later.
  2, 5 and 6 remain open.

## 9. Third review: cancelling an unlock (commit 68d3415)

- **Date:** 2026-11-26
- **Reviewer:** Claude, in a separate session that wrote none of this code (SEC-9).
- **Method:** reading the code only. Nothing was run, the server was not contacted,
  `.secrets/` was not opened, no code was changed. Only this section was added.
- **Scope:** the diff of 68d3415 and the current files: in `scripts/vcmount` `run()`,
  `do_mount` (the markers `CANCEL_FILE` and `UNLOCKING_FILE`), `command_cancel_unlock`
  and `command_busy`; the `cancel-unlock` case in `include/actions.php`; `cancelUnlock`,
  `otherBusy`, `stopOther` and the changed "busy" branch of `submitMount` in
  `js/vcmount.js`; the new button in `include/dialog.php`. From 28cc04b only the
  `KILL_GRACE` part of `run()`.

### 9.1 Summary

**Is the cancel path sound? Yes. It does not touch the password or the PIM, and it can
end no program except the engine's own `cryptsetup`.** No finding is a leak, and none is
rated high.

- **What the new action can do.** `cancel-unlock` starts the engine with a fixed
  argument list. It reads no field of the request: no name, no process number. Like every
  request it passes Unraid's login and CSRF check first. All it does is create an empty
  file. Only a mount that is waiting for `cryptsetup` reads that file, and that mount then
  ends the one child it started itself. It finds that child through the handle PHP gave it,
  not through a number someone passed in. PHP has not yet *collected* the child (asked the
  system for its exit status), so the child's process number cannot have passed to another
  program yet (one assumption, see C6).
- **Ending cryptsetup early cannot damage the volume.** cryptsetup only reads VeraCrypt
  headers and never writes them (SEC-7). Killing it during the password check leaves
  nothing behind. Killing it in the split second after the password was accepted can
  leave an open decrypted device. The code then locks the volume again, but does not
  check that this worked (C1).
- **The markers reveal nothing.** One is an empty file, the other holds the number of
  seconds since 1970. Both have fixed names and contain no volume name, path, password or
  PIM. `busy` passes on only a whole number of seconds.
- **Stale markers.** The marker is removed under the engine's lock before every unlock
  and again after it, so a marker left from earlier can never stop a later mount. A cancel
  that *arrives* late can (C3, a narrow race).
- **Signals.** They are caught only during the password check, and the handlers are
  reset on every path out of `run()`. During the check, a signal ends the unlock cleanly
  (except C1). After the check, a signal ends the engine at once, as it did before this
  commit (C5).
- **Password and PIM handling is unchanged.** The diff does not touch how they are read,
  checked or passed on. The new requests carry only the action and the CSRF token. After
  a "busy" answer the page asks the user again and does not resend anything.

| Check from the task | Result |
|---|---|
| Ends no process except the engine's own cryptsetup | Met. See C6 for the one assumption. |
| The markers reveal nothing | Met. |
| The markers cannot be abused through a link planted in `/var/run` | Met in practice, because only root can write there. The code itself follows links (C4). |
| A stale marker cannot cancel a later mount | Met. A late-arriving cancel can (C3). |
| Signal handlers removed afterwards, no half-mounted volume | Removed: yes. Half-mounted: not from a signal during the check (except C1). After the check, the same as before this commit (C5). |
| No password or PIM handling changed | Met. |
| SEC-1, SEC-2, SEC-3, SEC-7 | Met. |

### 9.2 Findings, most severe first

#### C1. Low-medium: a cancelled unlock may leave the volume unlocked without saying so

- **Where:** `do_mount` lines 1271-1275: `lock_again($mapper)` is called, its result is
  ignored, and the answer is "Unlocking was cancelled." `run()` line 698 cancels with
  SIGKILL, the stop signal a program cannot catch or delay.
- **What could go wrong:** the engine looks for the marker every half second. If it sees
  it just after cryptsetup has accepted the password, while cryptsetup is still setting up
  the decrypted device, cryptsetup is killed half-way. `lock_again` then runs
  `cryptsetup close`. If that fails (the device is held open for a moment, or it was left
  half set up and `close` does not recognise it; neither was tested),
  `/dev/mapper/vcm-<name>` stays open and its contents stay readable on the server. The
  dialog still says the unlock was cancelled. The other failure paths in `do_mount` say
  "It could NOT be locked again"; this one and the timeout path do not. The next mount of
  that volume is refused as "already unlocked or mounted".
- **How likely:** low. It needs a Cancel within milliseconds of the password being
  accepted, and then a failed close. **How bad:** medium. The owner believes the volume
  is locked while its contents can be read.
- **Suggested fix:** on the cancelled and timed-out paths, check what `lock_again`
  returns. If it failed, try once more after a second, then add "It could NOT be locked
  again" to the message, as the other paths do.

#### C2. Low: "busy" is now always read as somebody else's unlock, but it can be your own

- **Where:** `submitMount` lines 819-820 (an answer with code 6, "busy", now goes to
  `otherBusy` instead of `settle`); the comment above `settle` (735-740); `otherBusy` and
  `stopOther`.
- **What could go wrong:** `settle` was written for one case in particular: the browser
  sends the same mount request twice on its own. Browsers may do this when a connection
  that was kept open breaks before any answer arrives. The second copy finds the engine
  busy with the first copy and gets code 6, and only that answer reaches the page. Until
  this commit, the page then waited and reported the volume's real state. Now it says
  "Another volume is still being unlocked ... nothing was done" and offers "Stop that
  unlock", which would stop the user's own unlock with the right password. If the user
  does nothing, the volume gets mounted while the dialog says nothing was done. No secret
  is involved; the page simply says something untrue.
- **How likely:** low, because it needs a duplicate request. **How bad:** low: a wrong
  message, at worst an unwanted cancel.
- **Suggested fix:** keep both behaviours. Show the new message and button, and keep
  polling in the background as `settle` does. Once nothing is busy, if this volume is
  mounted, report it as mounted.

#### C3. Low: a cancel does not say which unlock it is for, so a late one can stop the next unlock and an early one gets lost

- **Where:** `command_cancel_unlock` (lines 2143-2157); `do_mount` line 1220 (removes the
  marker at the start) and line 1268 (removes it afterwards).
- **What could go wrong:** the marker only means "stop whatever unlock is running".
  1. A Cancel clicked just as unlock A finishes may reach the engine only after A is done
     and a new unlock B (from another tab or over SSH) has started. B is then cancelled.
  2. A Cancel clicked a fraction of a second after Mount may arrive before the mount
     reaches line 1220, which removes it. The unlock then runs to the end and may mount
     the volume, although the user's last click was Cancel.

  "Stop that unlock" likewise stops whichever unlock is running at the moment it is
  clicked. A marker left over from earlier never stops a later mount, because it is
  removed under the lock before every unlock.
- **How likely:** very low. Case 1 needs two people or tabs acting within a fraction of a
  second of each other; case 2 needs Mount and Cancel (or Escape) within about 0.1
  seconds. **How bad:** low. An unlock fails, or completes against the last click;
  nothing leaks.
- **Suggested fix:** acceptable as it is; noting the race in DESIGN-engine is enough. If a
  fix is wanted later: the page sends a random number with the mount and the same number
  with its Cancel. The engine keeps the number in `vcmount.unlocking` and honours only a
  cancel that carries it.

#### C4. Low: the marker files follow symbolic links

- **Where:** `touch(CANCEL_FILE)` (line 2148), `file_put_contents(UNLOCKING_FILE, ...)`
  (1264) and `file_get_contents(UNLOCKING_FILE)` (2174). The older `LOCK_FILE` does the
  same.
- **What could go wrong:** a *symbolic link* is a file that points to another file.
  Suppose someone placed `/var/run/vcmount.unlocking` as a link to
  `/boot/config/super.dat`. The next unlock would then overwrite that file, as root, with
  a time stamp. A link at `vcmount.cancel` would make `cancel-unlock` create an empty file
  wherever it points. And `busy` would read the link's target and, if the target holds
  only digits, reveal its value as "seconds since". Removing a link with `unlink` is
  harmless: it removes only the link, not the file it points to.
- **How likely:** practically nil. Normally only root can write to `/var/run` (open
  check 1), and root needs no trick to do any of this. **How bad:** high if it ever
  happened, which is why it is listed.
- **Suggested fix:** cheap defence in depth. Keep the three files in a folder of their
  own: the engine creates `/var/run/vcmount/` with mode 0700 and refuses to use it if it
  is a link or not owned by root. Alternatively, remove the name before writing and create
  the file fresh with `fopen(..., 'x')`, which fails if anything is already there.

#### C5. Low (not new): after the password check, a signal still ends the engine at once

- **Where:** `run()` lines 739-743 reset the handlers once cryptsetup has finished. After
  that come `do_mount` from line 1297 (blkid, the mount folder, mount) and
  `command_mount` lines 1429-1443 (share, dependents). Separately, `vcm_run` in
  `actions.php` (lines 222-230) sends SIGTERM to the engine after 300 seconds.
- **What could go wrong:** Ctrl+C, a closed SSH window or the page's 5-minute limit during
  these steps ends the engine without cleaning up. The volume can be left unlocked but not
  mounted, or mounted without its share or its dependents, and the mount folder may stay
  behind. The page then shows "The engine took too long and was stopped". The 5-minute
  limit is reachable: a slow unlock (up to 185 s), the network check (up to 65 s) and a
  few dependents (up to 65 s each) add up. Before this commit the same was true, and the
  unlock itself was worse, because cryptsetup ran on alone. The commit made the problem
  smaller.
- **How likely:** low. **How bad:** low-medium. Nothing is damaged, but the volume is not
  in the state that was asked for.
- **Suggested fix:** keep the three signals caught, but only noted, from the start of
  `do_mount` until the mount has either finished or been fully undone. A signal noted
  after the password check then means "finish cleanly, then stop".

#### C6. Informational

- **Process numbers.** A child's process number stays reserved until PHP collects the
  child. The exception is an engine started with SIGCHLD (the signal "a child has ended")
  set to "ignore": the system then collects children by itself and frees their numbers.
  Neither Unraid's web server nor a shell starts the engine that way today. One line at
  the start of a cancellable `run()`, `pcntl_signal(SIGCHLD, SIG_DFL)`, makes it certain.
  Even without it, the number would have to be handed to a new program within half a
  second.
- **Signal handling in `run()`:**
  - Afterwards the handlers are set to "default" rather than restored to what they were
    (`pcntl_signal_get_handler`), and this is not done in a `finally`.
  - They are installed after `proc_open`. That leaves a moment in which Ctrl+C ends the
    engine but not cryptsetup. Installing them first closes it.
  - If `stream_select` fails for a reason other than a signal, the loop breaks off. Then
    `proc_close` waits with no time limit and no cancel: the very hang 28cc04b fixed.
    Continuing the loop instead is safe, because the deadline still ends it.
  - `$signals = [SIGINT, ...]` is built on every call to `run()`, so every engine command
    needs PHP's pcntl module. Bob has it and it ships with Unraid (SEC-6). Building the
    list inside `if ($cancellable)` would limit that to the unlock.
- **Ctrl+C at the password prompt.** The engine kills cryptsetup with SIGKILL before
  cryptsetup can switch the terminal's echo back on, so what is typed next may not appear
  on screen until `reset`. That is the safe direction (nothing is shown), but it is
  confusing (open check 3).
- **If the engine itself is killed hard** (SIGKILL, or the system running out of memory),
  cryptsetup runs on alone. It probably also keeps the engine lock, because it inherits
  the lock file's handle: PHP does not open the lock file with close-on-exec. The page
  then reports an unlock that "Stop that unlock" cannot stop, because no engine is left
  to read the marker. This is a known limit and needs no fix now (open check 4).
- **`KILL_GRACE` (28cc04b) is sound.** SIGKILL goes only to the program `run()` started,
  only after `proc_get_status` reports that it still runs, and before it is collected. It
  applies to every program the engine starts, but changes the outcome only for programs
  that ignore SIGTERM. Children of the started program are not signalled, as before.
  180 + 5 seconds stays below the page's 300, and the page's countdown counts the same
  5 seconds.
- **The page.** `otherBusy` and `stopOther` show only numbers and fixed texts, through
  `.text()`. The new button has no `name` and is `type="button"`, so it never submits the
  form. Each of `stopOther`'s ten `busy` checks takes the lock for an instant, as `settle`
  does. An action started elsewhere at exactly that instant answers "busy".

### 9.3 What I checked and found in order

- **Web request.** `cancel-unlock` builds `['cancel-unlock', '--json']` and nothing else;
  it reads no field of the request. It is a POST like every action, so Unraid's token
  check runs first.
- **Engine, `cancel-unlock`.** It takes no arguments, creates the marker with `touch` and
  takes no lock. That is correct, since the mount holds the lock.
- **Engine, `busy`.** It reads the time file only while the lock is held, accepts only
  digits and returns `max(0, now - start)`.
- **Engine, `do_mount`.** The marker is removed after `take_lock` (in `command_mount`) and
  before any check. The time file is written just before `run()`. Both are removed in a
  `finally`, so also when `run()` throws. A cancelled unlock answers code 2 with a fixed
  text. For a saved volume the log says "could not unlock"; for "mount once" nothing is
  logged (PRIV-2 holds).
- **Engine, `run()`.** I traced every way out of the loop: the deadline (SIGTERM, then the
  grace period, then SIGKILL), a cancel or signal (SIGKILL), a failed `select`, and the
  normal end of output. All of them reach `proc_close` and the handler reset. Standard
  input is still passed through untouched, and the engine reads none of it, also on a
  cancel. Whatever is left unread disappears when the engine ends. SIGKILL writes no core
  dump (a copy of a program's memory saved to disk when it crashes), so cryptsetup's
  memory is not saved anywhere.
- **Page.** `cancelUnlock` stops the "Mount all" queue first, so no next volume is asked
  for, and it sends only the action. The dialog stays open until the mount's own answer
  arrives; `closeDialog` still refuses to close while a mount is under way. Escape
  triggers the same Cancel. The password and PIM fields were already emptied when Mount
  was clicked. After a "busy" answer the page asks for them again and keeps no copy.
- **Tests recorded in SPEC section 10** (2026-11-26): a cancel was answered within a
  second, and the right PIM mounted straight after. That also shows that no loop device
  (the kernel device that presents the volume file as a disk) and no decrypted device was
  left, or that mount would have been refused. Also tested: "Stop that unlock" after a
  reload, Ctrl+C in the web terminal, no cryptsetup left afterwards, and the PIM nowhere
  under `/var/log` and `/tmp`.

### 9.4 What I could not verify (open checks; read-only or on throwaway volumes)

1. **Who may write to `/var/run` (C4).** `ls -ld /var/run /run`: expected owner root,
   mode `drwxr-xr-x`.
2. **Nothing left after a cancel (C1).** After a Cancel and after Ctrl+C on
   `throwaway-pim`: no `/dev/mapper/vcm-*` and no loop device for the file
   (`/sys/block/loop*/loop/backing_file`). The recorded remount suggests this already; a
   direct look settles it.
3. **The terminal after Ctrl+C at the prompt (C6).** In Unraid's web terminal, press
   Ctrl+C while cryptsetup asks for the password, then type a harmless command such as
   `date`. Is it shown?
4. **Lock inheritance (C6).** During an unlock, `ls -l /proc/<cryptsetup's process
   number>/fd`: does it list `/var/run/vcmount.lock`?

### 9.5 Recommendation

The cancel path is sound and adds no way for a secret to leak. Two changes are worth
making before release: C1 (check what `lock_again` returns and say so, a few lines) and
C2 (keep `settle`'s check behind the new message). C3 to C6 can wait or be documented.

### 9.6 Follow-up (2026-11-27)

- **C1 fixed:** after a cancelled or timed-out unlock the engine checks that locking
  again worked, tries once more after a second, and otherwise says "The volume could
  NOT be locked again".
- **C2 fixed:** after a "busy" answer the page shows the message and keeps checking
  quietly; if this volume ends up mounted it reports it as mounted, otherwise it says
  when the other action is over. "Stop that unlock" ends that check.
- **C4 fixed:** the marker files are created fresh with `fopen(..., 'x')` after removing
  whatever had the name, and read only if they are plain files.
- **C6 fixed:** the signal handlers are installed before cryptsetup starts, SIGCHLD is
  set to default during the unlock, and all of them are restored to what they were in a
  `finally`; pcntl is needed only for the unlock. A failed `stream_select` no longer
  ends the wait early, so `proc_close` cannot wait without a limit.
- **C3** documented in DESIGN-engine; **C5** left for later.
- **Retested on Bob (2026-11-27, Unraid 7.4.1, by the owner):** Cancel in the dialog,
  the busy message with "Stop that unlock" after a reload, and Ctrl+C during the
  password check all passed; after Ctrl+C the terminal showed typed text normally.
- **Open checks of 9.4:** 1 passed: `/var/run` links to `/run`, owned by root, mode
  `drwxr-xr-x`. 2 passed: after the cancels `/dev/mapper` held only `control`. 3 passed
  for Ctrl+C during the check; Ctrl+C at the password prompt itself was not tried.
  4 not done.

## 10. Found in use: a stale "Require HTTPS" in the page (2026-11-27)

- **Found by the owner, not by a review.** The Settings and Volumes tabs share one
  browser page. After "Require HTTPS" was switched on and applied, the Volumes tab kept
  its earlier copy of the setting, so over plain HTTP the mount dialog still offered the
  password field. The server would have refused the mount (UI-5), but only after the
  password had crossed the network unencrypted: a gap in P1.
- **Fixed:** over plain HTTP the page asks the server for the setting each time the
  mount dialog opens, and again right before the password is sent. If the setting is on
  by then, nothing is sent, the password and PIM fields are emptied and the dialog shows
  the HTTPS notice. An unknown setting counts as on.
- **Tested on Bob** by the owner: switching the setting in either direction took effect
  at once, for "Mount a file once" and for saved volumes.

## 11. External audit (2026-11-27)

- **Who and how:** Gemini in Google's Antigravity, on a fresh clone of the public
  repository at commit `1d83816`, reading only. The full report is
  [`AUDIT-2026-11-27.md`](AUDIT-2026-11-27.md): 13 security findings (S1-S13) and 17
  bug groups (B1-B17).
- **Verdict:** no way for a password or PIM to leak, no way in without Unraid's login,
  the repository and its history hold no secrets, and the release pipeline is sound.
  Spot checks of its main claims (B1, B3, S2) against the code confirmed them.
- **Fixed in the first batch:**
  - S1: mount locations must be plain paths below `/mnt/` (no trailing slash, no
    backslash or `%`), no part of the path may be a link, and the location is checked
    again after the minutes an unlock can take.
  - S3: volume files must be ordinary files under `/mnt/`, checked before and after
    resolving links, with one message for every refusal.
  - S4: Cancel during the pre-send HTTPS check drops the check; nothing is sent.
  - S6: program names in log lines are quoted, so they are hidden with the volume
    names; program names are reduced to plain characters.
  - S7: "Let the share write" and "Fix permissions" take the engine lock before they
    check that the volume is mounted.
  - S9: Samba's reserved names are refused as share names; shares get
    `wide links = no`.
  - S12 (part): a network client opening the volume file during the unlock is caught
    before the mount.
  - B1, B2, B3, B13 (parts), B15 (1, 2, 4): see the report.
- **Open:** S2, S5, S8 and B4, B5, B7 need a plan and tests on Bob; the rest is listed
  in the report for later.
- **Fixed in the second batch (2026-11-27):**
  - S8: the `.plg` removes packages of other versions only after the new one was
    downloaded, checked against its SHA256 and installed.
  - B4: if Samba does not take up a new share, its file and include line are removed
    again, so the page does not show it as on and a later reload does not open it.
  - S5 (parts 3 and 4): a forced dismount notes each process's start time and signals
    only processes that still have it, so a reused process number is never hit and
    finished processes are not waited for; containers are recognised by
    `docker/<ID>` or `docker-<ID>` in their cgroup (on Bob: `0::/docker/<ID>`).
  - B5 (confirmed on Bob, then fixed): a volume with a keyfile and no password failed
    with cryptsetup code 1, because the page sent no input at all. `cryptsetup
    tcryptOpen --test-passphrase` with that keyfile gave code 0 for an empty line and
    code 1 ("Nothing to read on input") for no input. The password now always ends with
    a line break. Tested by the owner on `throwaway-the-keyfile` (keyfile only) and on
    a volume with a password: both mounted.
  - B7: the programs holding a volume now also include programs started from it
    (`/proc/<pid>/exe`) and files mapped into memory (`/proc/<pid>/maps`), so "still
    in use" names them and a forced dismount can end them. After closing the share,
    the unmount is retried for up to two seconds before the volume counts as busy.
    Tested by the owner: a volume whose share was open in Windows Explorer dismounted
    without "still in use".

