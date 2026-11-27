#!/usr/bin/env python3
"""
build.py: build the plugin package and write its version and checksum into
the .plg file. Runs the same on Windows, Linux and in GitHub Actions; it needs
only Python 3.

Usage:  python scripts/build.py [version]
        python scripts/build.py --check [version]

  version  date-based, YYYY.MM.DD, optionally with a letter for a second build
           on the same day (2026.11.16a). Default: today's date.

It writes:
  build/veracrypt.mount-<version>-noarch-1.txz
      A Slackware package, as Unraid's own plugins use: the files under src/
      with owner root and fixed permissions, and install/slack-desc. Python's
      tar module is used instead of makepkg (which Windows does not have), so
      owner and permissions do not depend on the computer that builds it.
  plugin/veracrypt.mount.plg
      Only its "version" and "sha256" lines change.

With --check (used by GitHub Actions for a release) the .plg is not changed:
the package is built, and the run fails unless the version and the SHA256 in
the .plg are exactly those of this build. The version then defaults to the one
in the .plg. Builds are reproducible (see MTIME), so a release can only carry
the package that was committed together with its .plg.

Nothing from tests/ and no volumes.dev.json goes into the package: only src/.
"""

import datetime
import hashlib
import io
import re
import sys
import tarfile
from pathlib import Path

NAME = 'veracrypt.mount'
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
PLG = ROOT / 'plugin' / f'{NAME}.plg'
SLACK_DESC = ROOT / 'plugin' / 'slack-desc'
BUILD = ROOT / 'build'

# Files that must be executable on the server. Everything else is 0644.
EXECUTABLE = {
    'usr/local/sbin/vcmount',
    f'usr/local/emhttp/plugins/{NAME}/scripts/vcmount',
    f'usr/local/emhttp/plugins/{NAME}/event/stopping_docker',
    f'usr/local/emhttp/plugins/{NAME}/event/docker_started',
    f'usr/local/emhttp/plugins/{NAME}/event/unmounting_disks',
}
# Files that are not text, so the line-ending check does not apply.
BINARY = {'.png'}
# Never in the package, even if such a file turns up under src/ by mistake.
FORBIDDEN = re.compile(r'(volumes\.dev\.json|volumes\.json|\.secrets|throwaway)', re.I)


def fail(message):
    print(f'build.py: {message}', file=sys.stderr)
    sys.exit(1)


# Every file in the package gets the same time stamp, midnight UTC of the
# version's date, so the same sources always give the same package, byte for
# byte. GitHub Actions relies on that to check a release against the .plg.
MTIME = 0


def strip_dev_only(rel, data):
    """Leave out the lines from "dev-only-begin" to "dev-only-end" (review H3):
    the development switch that reads volumes.dev.json is not shipped."""
    if rel.endswith(tuple(BINARY)):
        return data
    out, inside = [], False
    for line in data.decode('utf-8').split('\n'):
        if 'dev-only-begin' in line:
            if inside:
                fail(f'{rel}: "dev-only-begin" twice without "dev-only-end".')
            inside = True
        elif 'dev-only-end' in line:
            if not inside:
                fail(f'{rel}: "dev-only-end" without "dev-only-begin".')
            inside = False
        elif not inside:
            out.append(line)
    if inside:
        fail(f'{rel}: "dev-only-begin" without "dev-only-end".')
    text = '\n'.join(out)
    if 'volumes.dev.json' in text:
        fail(f'{rel}: still mentions volumes.dev.json outside a dev-only block.')
    return text.encode('utf-8')


def entry(name, mode, kind=tarfile.REGTYPE, size=0):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.mode = mode
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mtime = MTIME
    info.size = size
    return info


def plg_entity(plg, name):
    found = re.search(r'<!ENTITY ' + name + r'\s+"([^"]*)"', plg)
    return found.group(1) if found else None


def main():
    args = sys.argv[1:]
    check = '--check' in args
    args = [a for a in args if a != '--check']
    plg_now = PLG.read_text(encoding='utf-8')
    if args:
        version = args[0]
    elif check:
        version = plg_entity(plg_now, 'version') or ''
    else:
        version = datetime.date.today().strftime('%Y.%m.%d')
    if not re.fullmatch(r'\d{4}\.\d{2}\.\d{2}[a-z]?', version):
        fail(f'"{version}" is not a version like 2026.11.16 or 2026.11.16a.')
    # Every release says what changed, in the .plg that Unraid shows on update:
    # no build without a "###<version>" entry in <CHANGES>.
    changes = re.search(r'<CHANGES>(.*?)</CHANGES>', plg_now, re.S)
    if not changes or not re.search(rf'^###{re.escape(version)}\s*$', changes.group(1), re.M):
        fail(f'the .plg has no changelog entry for {version}. Add "###{version}" with a line or two '
             'for users at the top of <CHANGES> in plugin/veracrypt.mount.plg.')
    global MTIME
    day = datetime.datetime.strptime(version[:10], '%Y.%m.%d').replace(tzinfo=datetime.timezone.utc)
    MTIME = int(day.timestamp())

    # Sorted by the plain path text: Windows would otherwise ignore upper and lower
    # case, Linux not, and the same sources would give two different packages.
    files = sorted((p for p in SRC.rglob('*') if p.is_file()), key=lambda p: p.relative_to(SRC).as_posix())
    if not files:
        fail('src/ holds no files.')
    for path in files:
        rel = path.relative_to(SRC).as_posix()
        if FORBIDDEN.search(rel):
            fail(f'refusing to package {rel}.')
        # Images are binary: a PNG's own signature contains the bytes \r\n.
        if path.suffix.lower() not in BINARY and b'\r\n' in path.read_bytes():
            fail(f'{rel} has Windows line endings; they break scripts on Unraid.')
    missing = EXECUTABLE - {p.relative_to(SRC).as_posix() for p in files}
    if missing:
        fail('missing: ' + ', '.join(sorted(missing)))

    BUILD.mkdir(exist_ok=True)
    package = BUILD / f'{NAME}-{version}-noarch-1.txz'
    with tarfile.open(package, 'w:xz', format=tarfile.GNU_FORMAT) as tar:
        folders = set()
        for path in files:
            parts = path.relative_to(SRC).parts
            for i in range(1, len(parts)):
                folders.add('/'.join(parts[:i]))
        for folder in sorted(folders):
            tar.addfile(entry(folder + '/', 0o755, tarfile.DIRTYPE))
        for path in files:
            rel = path.relative_to(SRC).as_posix()
            data = strip_dev_only(rel, path.read_bytes())
            tar.addfile(entry(rel, 0o755 if rel in EXECUTABLE else 0o644, size=len(data)), io.BytesIO(data))
        desc = SLACK_DESC.read_bytes()
        tar.addfile(entry('install/', 0o755, tarfile.DIRTYPE))
        tar.addfile(entry('install/slack-desc', 0o644, size=len(desc)), io.BytesIO(desc))

    sha256 = hashlib.sha256(package.read_bytes()).hexdigest()
    if check:
        print(f'Package: {package.relative_to(ROOT).as_posix()} ({package.stat().st_size} bytes, {len(files)} files)')
        print(f'SHA256:  {sha256}')
        if plg_entity(plg_now, 'version') != version or plg_entity(plg_now, 'sha256') != sha256:
            fail(f'the .plg does not describe this build: it says version {plg_entity(plg_now, "version")}, '
                 f'sha256 {plg_entity(plg_now, "sha256")}. Run build.py {version} and commit the .plg.')
        print('Check:   the .plg matches this build.')
        return
    plg = plg_now
    plg, n1 = re.subn(r'(<!ENTITY version\s+")[^"]*(")', rf'\g<1>{version}\g<2>', plg)
    plg, n2 = re.subn(r'(<!ENTITY sha256\s+")[^"]*(")', rf'\g<1>{sha256}\g<2>', plg)
    if n1 != 1 or n2 != 1:
        fail('could not find the version and sha256 lines in the .plg.')
    PLG.write_bytes(plg.encode('utf-8'))

    print(f'Package: {package.relative_to(ROOT).as_posix()} ({package.stat().st_size} bytes, {len(files)} files)')
    print(f'SHA256:  {sha256}')
    print(f'Updated: {PLG.relative_to(ROOT).as_posix()} (version {version})')


if __name__ == '__main__':
    main()
