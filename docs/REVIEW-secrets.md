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
