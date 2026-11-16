# Design note: the web interface

Status: **agreed** (2026-11-16). Nothing of this is built yet.

This note says how the web pages are put together and, above all, how a password
travels from the browser to `cryptsetup`. The look follows the mockups that were
reviewed on 2026-11-15 (`mockups/index.html`, UI-6). The engine is described in
`docs/DESIGN-engine.md`; the pages contain no mount logic of their own (CLI-1).

## 1. How an Unraid plugin page works

Checked on Bob, 2026-11-16, by reading other plugins' pages:

- A page is a file ending in `.page`: a few header lines, then HTML and PHP.
- The header line `Menu="Utilities"` puts a page under Settings, section User
  Utilities (as Unassigned Devices, ZFS Master and others do). Child pages with
  `Menu="VeraCryptMount:1"` and `:2` become its tabs.
- `Menu="Dashboard:0"` adds a tile to the Dashboard (as Tailscale does).
- `Menu="Main:<n>"` adds a section to the Main page.
- **CSRF (SEC-2):** Unraid itself checks every POST request to a PHP file. Without
  the right `csrf_token` the request is stopped before our code runs and the attempt
  is written to the system log (`webGui/include/local_prepend.php`). Our pages only
  have to send the token, which Unraid hands every page.

## 2. Files

All below `/usr/local/emhttp/plugins/veracrypt.mount/`:

| File | What it is |
| --- | --- |
| `VeraCryptMount.page` | The page under Settings › User Utilities, holder of the two tabs |
| `VeraCryptMountVolumes.page` | Tab 1: the volume list with Mount, Dismount, Add, Edit |
| `VeraCryptMountSettings.page` | Tab 2: the plugin's settings |
| `VeraCryptMountDashboard.page` | The Dashboard tile (UI-2) |
| `VeraCryptMountMain.page` | The optional section on the Main page, shown only when the setting is on (UI-3) |
| `include/action.php` | The one address the pages send requests to |
| `js/vcmount.js`, `css/vcmount.css` | Shared by all pages |

## 3. How the pages talk to the engine

- Every page asks `include/action.php` for what it needs, always with a POST request
  that carries the CSRF token.
- `action.php` accepts a short, fixed list of actions: `list`, `status`, `mount`,
  `mount-once` (without saving, VOL-5), `dismount`, `dismount-force`, `repair-shares`,
  `save-config`, `options`. Anything else is refused.
- For each action it starts `vcmount` with `--json`, **directly from a list of
  arguments, without a shell** (SEC-3), the same way the engine starts `cryptsetup`.
  The volume name is checked against the engine's name pattern first.
- The logic sits in `include/actions.php`, in one function that takes the request and
  returns the answer; `action.php` only adds the web part. So the logic can be tested
  on Bob without a browser (`scripts/actiontest.sh`).
- The "require HTTPS" rule is checked by the engine, not here: for a request over plain
  HTTP, `action.php` adds `--over-http` to the mount, and the engine refuses it while
  the setting is on. All rules stay in one place.
- It passes the engine's JSON answer back to the page unchanged. The page shows the
  result in Unraid's own dialogs and message bars (UI-1).
- While the page is open and visible, it asks for `list` every 5 seconds, so a mount
  done elsewhere (SSH, Dashboard, array start) shows up. When the browser tab is hidden,
  it stops asking.
- When the volume list loads, it calls `repair-shares` once, quietly. If another action
  is running (code 6), it skips it.

## 4. How the password travels (the part to review)

```
password field ──HTTPS or HTTP──▶ action.php ──standard input──▶ vcmount ──▶ cryptsetup
 (browser)        POST body        (PHP, in RAM)                  (passes it straight on)
```

1. **Browser.** A real form with a real password field (`type="password"`,
   `autocomplete="current-password"`), and a hidden user-name field holding the
   volume name. That lets a password manager keep one entry per volume (UI-4). The
   field is emptied as soon as the request is sent.
2. **On the way.** The password is in the body of the POST request, never in the
   address. Over HTTPS it is encrypted. Over plain HTTP anyone on the network could
   read it, so the dialog shows a visible warning (UI-5). With the setting
   "require HTTPS" on, a page opened over plain HTTP offers no password field at all,
   only a link to the HTTPS address, so the password cannot leave the browser (review
   P1, 2026-11-17). The server keeps its own check as the second line of defence: a
   mount that came over plain HTTP is refused. That check alone cannot prevent the
   leak, because it runs only after the password has arrived. PHP itself reads whether
   the request came over HTTPS, so the browser cannot pretend; behind a reverse proxy
   it sees only the last leg (review H7).
3. **action.php.** Takes the password out of the request, starts `vcmount mount <name>
   --json`, writes the password into its standard input, closes it, and drops the
   variable. It never writes the password anywhere, never puts it in a command line
   or environment variable, and never includes it in an error message (SEC-1).
4. **vcmount and cryptsetup.** As today: the engine never reads it; `cryptsetup` reads
   it straight from standard input.

Limits, stated plainly:

- For the few seconds of the request the password is in the memory of the web
  server's PHP process. That cannot be avoided with a web page. It is the same for
  every Unraid plugin that takes a password.
- Unraid's web server does not log request bodies (checked, section 9).

Over SSH (`vcmount mount` typed by hand) the password never touches the web server at
all (CLI-3).

## 5. Saving settings

- Settings are only written when the user presses Save. That is the only moment the
  plugin writes to the flash drive (Decision D4).
- **Proposal U1:** `action.php` does not write the file itself. It hands the new
  settings to a new engine command, `vcmount save-config`, on standard input. The
  engine checks them with the same code it uses when reading them (names, paths,
  dependents, share users) and writes the file safely: to a temporary file, then
  renamed over the old one. So there is one place that knows what valid settings are.
- What the forms need to offer choices comes from a new command `vcmount options
  --json`: the Unraid users (for the share) and the Docker containers (for the
  dependents). The volume file is picked with Unraid's own file browser.

## 6. The pages

**`VeraCryptMount.page` must stay a header only.** Unraid turns the top page of a
tabbed plugin into a tab of its own as soon as anything follows the `---` line, even a
PHP comment (seen 2026-11-16: an empty first tab appeared). Notes about it belong here:

- Its `Icon=` line holds the plugin's own drawing (a lock with VC, also used in the
  Dashboard tile), not the VeraCrypt logo, which is a trademark. Unraid passes an icon
  that starts with `<` through as is (`process_icon` in
  `DefaultPageLayout/MainContent.php`), so it takes the theme's text colour like the
  font icons next to it. The header is read as an ini file: single quotes only inside
  the drawing, and no `;`. The view box is cropped to the drawing so it fills its
  33 pixels like the font icons next to it.

Following the mockups:

- **Volumes tab.** One row per volume: name, state, where mounted, size and free space,
  share, dependents. Buttons: Mount (opens the password dialog), Dismount, Edit. Below:
  Add volume, Mount a file once (VOL-5), Mount all, Dismount all (VOL-6).
- **Dismount that fails (code 5).** The dialog shows which programs hold the volume
  open and offers Force, with a second confirmation (LIFE-5).
- **Edit dialog.** Name, display name, volume file, mount location, read-only, share
  (users, read-only, hidden), dependents (order, grace period, delay).
- **Settings tab.** Force at array stop (LIFE-10), require HTTPS (UI-5), show on the
  Main page (UI-3).
- **Dashboard tile.** One line per volume with its state and a Mount or Dismount
  button. Mount opens the same password dialog.
- **Warnings shown at the top** when they apply: plain HTTP (UI-5), an activity-logging
  plugin is installed (PRIV-3), SMB is turned off while a volume should be shared.

## 7. Language

**Proposal U2:** English only for version 1. The texts are kept in one place so that
Unraid's translation system can be added later.

## 8. Order of building

1. `action.php` and the two new engine commands, with tests.
2. The Volumes tab with the password dialog. First real check of the password path.
3. Edit dialog and saving.
4. Settings tab, Dashboard tile, Main page section.
5. The separate security review of the secret handling (SEC-9), before first real use.

## 9. Checked on Bob (2026-11-16, read-only)

1. **PHP runs as root** (`/etc/php-fpm.d/www.conf`: `user = root`). `action.php` can
   start the engine directly.
2. **Time limits are long enough.** The web server waits up to 640 seconds for PHP
   (`fastcgi_read_timeout 640s` in `/etc/nginx/nginx.conf`), and PHP's own request
   limit is off (`request_terminate_timeout` not set). The engine stops `cryptsetup`
   after 180 seconds, well inside that. Time spent waiting for another program does
   not count towards PHP's `max_execution_time` on Linux.
3. **Request bodies are not logged.** The web server's access log is off
   (`access_log off`); its error log goes to the system log and never contains request
   bodies. PHP logs only errors of the code itself, and `action.php` never puts the
   password into a message.
4. **HTTPS is visible to PHP.** The web server passes `HTTPS` to PHP when the page was
   reached over HTTPS (`fastcgi_param HTTPS $https` in `/etc/nginx/fastcgi_params`), so
   `action.php` checks `$_SERVER['HTTPS']`.
5. **A page can be hidden by a condition.** A `.page` header line `Cond="..."` holds a
   PHP expression, for example `Cond="file_exists('/boot/config/network-rules.cfg')"`
   in Unraid's own pages. The Main page section uses it to read our setting.

## 10. Decisions (agreed 2026-11-16)

| No. | Question | Agreed |
| --- | --- | --- |
| U1 | Who writes the settings file | The engine (`vcmount save-config`), not the web page |
| U2 | Languages in version 1 | English only, texts kept in one place |
| U3 | Refreshing the page | Ask every 5 seconds while the page is visible |
| U4 | Repairing shares | Quietly, when the volume list loads |
