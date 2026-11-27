# Security

VeraCrypt Mount handles volume passwords and runs as root on your server, so security
problems matter. Thank you for reporting them.

## Reporting a problem

Please **do not** open a public issue for a security problem. Report it privately
instead: on this repository's **Security** tab, choose **Report a vulnerability**.
Describe what you found, how to reproduce it, and which version you use (shown on
Unraid's Plugins page).

You will get an answer as soon as possible. This is a one-person project, so a fix
may take some days; you will be told what is planned.

## What counts

For example:

- a password, PIM or keyfile content that ends up anywhere other than `cryptsetup`'s
  standard input (a file, a log, a command line, a notification, the browser's
  address bar);
- a way for someone without root to read a mounted volume or to mount, dismount or
  change one;
- a way to make the plugin act on files or folders outside what its settings name.

How the password is handled, and the reviews of that path, are described in
[`docs/REVIEW-secrets.md`](docs/REVIEW-secrets.md).

## Supported versions

Only the newest release is supported. Update through Unraid's Plugins page.
