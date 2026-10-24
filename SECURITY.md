# Security policy

## Supported versions

Only the latest release gets fixes. Upgrade before reporting:
see [Upgrading](README.md#upgrading).

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting instead:
**Security › Report a vulnerability** on this repository
(<https://github.com/row2002/mangodesk/security/advisories/new>). If that page isn't
available, open an issue that says only that you have a security report and how to
reach you, without details.

Include the MangoDesk version (`mangodesk --version`), how you run it (binary, npx,
source), your OS, and steps to reproduce. Expect a first answer within a week.

## Scope

MangoDesk is a local, single-user tool without a login. By design it:

- listens on 127.0.0.1 only, and refuses requests with a non-loopback `Host`
  header (DNS rebinding) or writes from another site (CSRF);
- stores connection strings, passwords included, in plain text in an owner-only
  (0600 on macOS/Linux) file.

Ways around those protections — a web page or another machine reading the API or
the stored credentials — are in scope. Other local users or processes on the same
machine reaching 127.0.0.1, and anything that needs the stored file to already be
readable, are not.
