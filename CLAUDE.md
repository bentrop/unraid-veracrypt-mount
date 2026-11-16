# Project instructions

This repository is an Unraid plugin, "VeraCrypt Mount" (ID `veracrypt.mount`), that
mounts VeraCrypt volumes with the built-in `cryptsetup`, offers SMB shares and
controls dependent Docker containers.

@CLAUDE.local.md

**Read `docs/SPEC.md` before doing anything.** It holds the agreed requirements, their
status (Agreed / Proposed / Verify) and the test results. `docs/DESIGN-engine.md` and
`docs/DESIGN-ui.md` describe how the engine and the web pages are built;
`docs/REVIEW-secrets.md` is the security review of the password path.

The line above pulls in `CLAUDE.local.md`, the owner's private instructions (their
server, how to work with them). It is excluded from Git; without it, ask the person
you work with about their setup.

## Rules

### Working on a server

- Ask before every command that touches the server, and say in plain words what it
  does and which files it reads or changes. One purpose per command.
- Test only against throwaway volumes and throwaway containers. Never open, mount,
  move or modify any other volume or file, and never stop, start or kill a real
  container.
- Never force a dismount, kill a container or run a filesystem repair on the server
  without explicit confirmation for that specific action. (The plugin itself may do
  these where the spec says so.)
- The flash drive (`/boot`) is only written by installing or removing this plugin.
  Suggest a fresh flash backup before any change to how the plugin installs itself.

### Secrets

- No password, PIM, keyfile or key ever goes into the repository, a command line, a
  log or a commit message.
- Secrets reach `cryptsetup` through standard input only.
- Local details stay in `.secrets/` (excluded from Git): test credentials, the server
  address (`.secrets/server`) and the test user (`.secrets/test-user`), read by
  `scripts/local.sh`. Before each commit, check that the test password is not in it.

### Files

- Unix line endings everywhere (`.gitattributes` enforces it); Windows line endings
  break scripts on Unraid.
- Use the words from the spec: **volume** for a VeraCrypt file, **container** for a
  Docker container, **dependent** for a container tied to a volume.

## Workflow

- **Fast loop:** `scripts/deployweb.sh install` copies the pages and the engine into
  the plugin folder on the server (in RAM; a reboot undoes it).
- **Package:** `python scripts/build.py <version>` builds the package into `build/`
  and writes version and SHA256 into `plugin/veracrypt.mount.plg`.
- **Release:** commit the `.plg`, push the version as a tag; GitHub Actions
  (`.github/workflows/release.yml`) rebuilds, checks and publishes it.
- Before UI work, read how Unraid's own pages do the same thing on the server and
  reuse their markup; anything added to a shared Unraid page (Dashboard, Main) can
  break that page.
