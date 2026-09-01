---
title: Installation
description: Docs intro
icon: simple/docker
---

You have a few options for deploying homepage, depending on your needs. We offer docker images for a majority of platforms. You can also install and run homepage from source if Docker is not your thing. It can even be installed on Kubernetes with Helm.

!!! info

    Please note that when using features such as widgets, Homepage can access personal information (for example from your home automation system). As of v2.0 Homepage includes a simple authentication gate with a password or OIDC, described in Security & Authentication below. We still recommend homepage be deployed behind a reverse proxy including authentication, SSL etc, and / or behind a VPN.

<br>

<div class="grid cards" style="margin: 0 auto;" markdown>
[:simple-docker: &nbsp; Install on Docker :octicons-arrow-right-24:](docker.md)
{ .card }

[:simple-kubernetes: &nbsp; Install on Kubernetes :octicons-arrow-right-24:](k8s.md)
{ .card }

[:simple-unraid: &nbsp; Install on UNRAID :octicons-arrow-right-24:](unraid.md)
{ .card }

[:simple-nextdotjs: &nbsp; Building from source :octicons-arrow-right-24:](source.md)
{ .card }

</div>

### `HOMEPAGE_ALLOWED_HOSTS`

As of v1.0 there is one required environment variable to access homepage via a URL other than `localhost`, <code>HOMEPAGE_ALLOWED_HOSTS</code>. The setting helps prevent certain kinds of attacks when retrieving data from the homepage API proxy.

The value is a comma-separated (no spaces) list of allowed hosts (sometimes with the port) that can host your homepage install. See the [docker](docker.md), [kubernetes](k8s.md) and [source](source.md) installation pages for more information about where / how to set the variable.

`localhost:3000` and `127.0.0.1:3000` are always included, but you can add a domain or IP address to this list to allow that host such as `HOMEPAGE_ALLOWED_HOSTS=gethomepage.dev,192.168.1.2:1234`, etc.

If you are seeing errors about host validation, check the homepage logs and ensure that the host exactly as output in the logs is in the `HOMEPAGE_ALLOWED_HOSTS` list.

This can be disabled by setting `HOMEPAGE_ALLOWED_HOSTS` to `*` but this is not recommended. Public deployments must rely on a reverse proxy (and/or VPN) that enforces authentication, TLS, and unexpected Host headers; the built-in host check is a best-effort guard for local setups and is not a substitute for edge protections.

!!! note

    The NextAuth routes (`/api/auth/*`) and sign-in pages (`/auth/*`) are exempt from this check so that authentication continues to work, they do not access the API proxy.

### Security & Authentication

**Dashboard login is on by default.** On the first server start with no
`config/auth.json` and no authentication environment variables set, Homepage
creates a bootstrap user `admin` / `admin`, auto-generates the session signing
secret into `config/auth.json` (file mode `0600`), and prints a one-time notice
to the console telling you to change the credentials. Every page then shows a
non-dismissible red banner until the password is changed.

!!! warning

    `admin` / `admin` is online-guessable. **Change the credentials before you
    expose the dashboard publicly** (reverse proxy, tunnel, port-forward). Either
    open **`/security` → Account** and run the change-credentials wizard, or pin
    the credentials up front with `HOMEPAGE_AUTH_USERNAME` +
    `HOMEPAGE_AUTH_PASSWORD` (env-set credentials skip the bootstrap user and the
    banner entirely).

To disable login completely — a trusted-LAN-only deployment that wants no gate
at all — set `HOMEPAGE_AUTH_ENABLED=false`.

Environment variables:

- `HOMEPAGE_AUTH_ENABLED` — defaults to on. Set to `false` to disable the login
  gate entirely.
- `HOMEPAGE_AUTH_SECRET` — the cookie signing/encryption secret. **Auto-generated
  into `config/auth.json` on first start**, so you normally don't set this. Set
  it explicitly (a random string, at least 32 characters — generate one with
  `openssl rand -base64 32`) only when running multiple replicas that must share
  a secret, or when `config/` is read-only so Homepage can't persist one.
- `HOMEPAGE_EXTERNAL_URL` — the absolute URL used to reach Homepage, including
  scheme and port when needed. **Optional for password login** (it was required
  in earlier versions). Still required for OIDC, and required for any
  TLS-terminated deployment so the authentication cookies are marked `Secure`.
- `HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD` — pin the password-login
  credentials via the environment instead of the stored user. When both are set
  they take precedence over `config/auth.json`, and no bootstrap `admin` user or
  change-credentials banner is created.

Use an `https://` URL for public or TLS-terminated deployments so authentication
cookies are marked `Secure`. Trusted HTTP-only LAN deployments may use an
`http://` URL.

#### Recovering a forgotten password

Delete `config/auth.json` (or just remove the `user` key from it) and restart.
The next start recreates the `admin` / `admin` bootstrap user (unless
`HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD` are set, in which case those
apply). The auto-generated `secret` in the same file is regenerated too if you
delete the whole file, which invalidates existing session cookies.

#### Two-factor authentication (TOTP)

An authenticator-app second factor is enrolled from the **Security** page
(`/security`) — either from the standalone **Two-factor authentication** card,
or as the optional step 2 of the **Account** change-credentials wizard. Scan the
QR code, confirm a code, and every subsequent sign-in asks for the 6-digit code
after the password.

2FA state is stored in `config/auth.json` (created automatically). If you lose
access to your authenticator, delete or empty that file to disable 2FA; the next
sign-in will only require the username and password.

!!! warning

    Homepage applies an in-process progressive-delay throttle to `authorize()`:
    after 5 wrong passwords a sign-in attempt is blocked for a growing interval
    (capped at 30 seconds) without evaluating the password hash. This is a
    best-effort in-memory guard, not a substitute for edge protection.
    Deployments exposed outside a trusted network should **also** configure their
    reverse proxy or ingress to rate limit `POST` requests to
    `/api/auth/callback/credentials`. Each failed attempt is logged at `warn`
    level as `<nextauth> Failed password sign-in attempt`, which can be used as a
    fail2ban or CrowdSec filter.

!!! danger "Breaking changes"

    1. **Login is now on by default.** Any deployment that did *not* set
       `HOMEPAGE_AUTH_ENABLED` previously had no login and now shows a sign-in
       screen (with the bootstrap `admin` / `admin` user). To keep no login, set
       `HOMEPAGE_AUTH_ENABLED=false`.
    2. **`/api/mcp` now requires authentication by default.** The MCP endpoint
       gates its session check on whether auth is enabled; with auth on by
       default, `/api/mcp` now needs a bearer token *or* a signed-in session
       unless `HOMEPAGE_AUTH_ENABLED=false`. The `HOMEPAGE_MCP_TOKEN` path is
       unaffected.

For OIDC login (overrides password login):

- `HOMEPAGE_OIDC_ISSUER` (OIDC issuer URL, e.g., `https://auth.example.com/realms/homepage`)
- `HOMEPAGE_OIDC_CLIENT_ID`
- `HOMEPAGE_OIDC_CLIENT_SECRET`
- Optional: `HOMEPAGE_OIDC_NAME` (display name), `HOMEPAGE_OIDC_SCOPE` (defaults to `openid email profile`)

!!! warning

    Homepage grants access to any identity that the configured OIDC provider authorizes for this client. Configure client assignments, groups, or access policies at the identity provider. Homepage does not apply additional claim-based authorization.

All app pages and `/api` routes except `/api/healthcheck` will require a signed-in session. Static assets remain public.

Configure your OIDC provider with the a callback URI like `https://homepage.example.com/api/auth/callback/homepage-oidc`.
