# Security review, 2026-09-28

Status (updated after the fixes): **the critical and all four high findings are fixed and verified; the medium and low findings are pending** (listed in `docs/plan.md`, "Security review: pending issues"). What was changed and why: `docs/decisions.md`, Step V. The findings below are kept as written, for the evidence.

| Finding | Status | How it was checked |
|---|---|---|
| C1 Data API open | **Fixed, live** (migration `close_data_api`, applied) | Catalogue: 52 of 52 tables with RLS, no `anon` or `authenticated` privileges; the app's own connection still reads; a new table starts closed; the public key now gets `42501` on every table and the schema listing is closed. Confirmed exposed first with `supabase config diff` |
| H1 URL filter | **Fixed** (`server/outbound.ts`) | Every spelling from the probe is now refused (tests); the connection is pinned to the checked address |
| H2 Windows data folder and service account | **Fixed in the scripts**, not yet on a real service | Folder, file and task-permission helpers run on scratch folders and a throwaway task (the "before" state showed `BUILTIN\Users:(RX)` inherited). The service-account switch has a fallback to LocalSystem but has not been run on a real service |
| H3 trust anchors | **Fixed in code; needs one step from you** | Signing and verifying run with the real release key end to end (valid passes; changed file, other version, downgrade and missing signature refused). Built-in manifest key checked against what production serves. **Set the `GATEWAY_RELEASE_SIGNING_KEY` repository secret** (I could not: the sandbox blocks writing secrets). Docker installs and the installer are not covered yet (M8) |
| H4 panel WebSocket | **Fixed** | Real panel loads under the new CSP in Chrome; a page from another origin gets `1008 bad origin` and no data; a rebinding Host gets 421; walls and lifts are throttled and logged. Rooms still default to open (a product decision, see M4) |

This report is in the repository (private) because the plan and the decision log refer to it. It still describes the pending medium issues, so keep the repository private.

Method: white-box review of the repository at `main` (`2675ff1`), plus tests run **locally**: a probe of the URL filter, a run of a local gateway against a traversal wordlist, `pnpm audit`, a secrets scan of tracked files and history, and one **read-only query of the database catalogue** (privileges and RLS flags only, no customer data). No live requests were made to the deployed site. Severity is my judgement of impact times likelihood for this product (customer AV rooms, multi-tenant, gateways on customer networks).

## How much of the code was covered

Read in full or tested: the tRPC foundation (`trpc.ts`, `proxy.ts`), all public and gateway routes, the gateway protocol and its schemas, the crypto package, gateway announce, enrolment, heartbeat, updater and `update.ps1`, panel server, phone control, API keys, cron auth, alert and ticket outbound calls, staff and support-session gating, CI workflows, Docker files, the Windows install scripts, custom-driver regex handling.

Covered by **automated scans plus targeted reads only**: the 33 tRPC routers (a script checked that every Prisma query on an organisation-owned model is scoped by `orgId`, and every mutation has a role check; results below). **Not reviewed in depth**: marketplace and billing logic beyond the webhook, MSP grant logic, the staff routers, the browser panel and portal components, and Supabase Auth dashboard settings (email confirmation, MFA, password policy), Vercel settings. Say if you want any of these taken further.

## Summary

| # | Sev | Finding | Verified |
|---|---|---|---|
| C1 | **Critical** | No row level security on any table; the `anon` role can read and write all 52 | Privileges verified in the database. Whether the Data API is switched on is **not yet verified** |
| H1 | High | The "public address only" filter for webhooks lets internal addresses through (IPv6 forms) | Reproduced |
| H2 | High | Windows gateway data folder readable by any local user; service runs as SYSTEM | Read from the install scripts |
| H3 | High | Gateway trust anchors sit in the cloud: signing keys and update bundles are vouched for by the same server that could be compromised | Read from the code |
| H4 | High | Panel WebSocket has no Origin check, and rooms default to open; physical actuators are reachable | Read from the code |
| M1 | Medium | Open redirect after sign-in (`/\t/evil.com`) | URL behaviour reproduced; router behaviour inferred |
| M2 | Medium | No security headers on the portal (CSP, frame-ancestors, nosniff, Permissions-Policy) | Read from config |
| M3 | Medium | No effective rate limiting on unauthenticated endpoints | Read from the code |
| M4 | Medium | Panel PIN: per-address lockout only, short PINs, hash distributed in manifests | Read from the code |
| M5 | Medium | Phone-control sessions last 2 hours, cannot be revoked, and allow every panel action | Read from the code |
| M6 | Medium | Alert emails go to unverified addresses with user-controlled text: a spam and phishing relay from Kestrel's sending domain | Read from the code |
| M7 | Medium | Vulnerable dependency in the gateway (`@fastify/static`); 10 advisories in all | `pnpm audit`; traversal tested and blocked |
| M8 | Medium | CI and supply chain: unpinned actions, default token permissions, unsigned images and installer, mutable rolling releases, unmaintained Watchtower with the Docker socket | Read from the workflows |
| M9 | Medium | Custom-driver regexes are only syntax-checked: a catastrophic pattern stalls the gateway | Read from the code |
| M10 | Medium | The gateway's new local admin page sends its code and tokens over plain HTTP on the LAN; the status page lists room ids | Read from the code (my own work) |
| M11 | Medium | The unauthenticated announce endpoint can be filled to its cap, blocking the claim flow | Read from the code |
| M12 | Medium | A dev-role user can point a gateway at any address, including the machine itself and link-local addresses | Read from the code |
| L1 to L10 | Low | See the end | |

## C1. Row level security is off everywhere (Critical, act first)

**Evidence.** A read-only catalogue query on the shared database returned: 52 tables in `public`, **0 with RLS enabled**, `anon` has **SELECT on 52 and INSERT on 52**, `authenticated` has SELECT on 52, no policies exist. No migration mentions RLS. `CLAUDE.md` and `phase-4-preread.md` say RLS is "defence-in-depth", which is not the case today.

**Why it matters.** Supabase exposes the `public` schema through its Data API (PostgREST). The `anon` key is designed to be public and is in the browser bundle (`NEXT_PUBLIC_SUPABASE_ANON_KEY`). With RLS off and these privileges, anyone on the internet with that key could read (and, with INSERT/UPDATE/DELETE, change) every tenant's rows: member emails, gateway and API-key hashes, alert channel settings (Teams and webhook URLs, webhook secrets), sealed credential blobs, tickets, staff users. Writes would allow privilege escalation (for example inserting themselves as an owner of another organisation, or changing a plan). Prisma connects as the owner and is not affected by RLS, so the application layer's `orgId` scoping never protects this path.

**Still to confirm (needs you, in the Supabase dashboard):** Settings > API (or Data API): is the `public` schema exposed? If the Data API is off, the exposure is closed and this drops to High (still fix it). Also check the project's API logs for `/rest/v1/` requests that did not come from you, since the shared database also backs Production.

**The application never uses the Data API** (no `.from()`, `.rpc()`, storage or realtime calls; the Supabase clients are used for Auth only), so closing it costs nothing.

**Recommended fix (everywhere = every table, including `_prisma_migrations`):**
1. A migration that runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (and `FORCE`) on every `public` table, `REVOKE ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM anon, authenticated`, and `ALTER DEFAULT PRIVILEGES ... REVOKE` so new tables come up closed.
2. Turn the Data API off (or remove `public` from exposed schemas) unless a use appears.
3. A test or CI check that fails when a `public` table has RLS off or is granted to `anon`, so a later migration cannot reopen it.
4. If the API logs show outside access, treat it as a possible data breach (LR-13, Notifiable Data Breaches) and rotate what was readable: Teams and webhook URLs and webhook secrets, then re-issue gateway tokens and API keys.

## H1. SSRF filter bypass (High)

**Evidence** (reproduced with a probe against the real function): `assertPublicUrl` in `apps/web/src/server/alerts.ts:92` accepts `https://[::ffff:7f00:1]/` (127.0.0.1), `[::ffff:a00:1]` (10.0.0.1), `[::ffff:a9fe:a9fe]` (169.254.169.254), `[::a00:1]`, `[64:ff9b::a00:1]`, `[2002:a00:1::]`, and also `192.0.0.1` and `198.18.0.1`. The IPv4-mapped check only matches the dotted spelling, but the URL parser normalises to the hex spelling. Blocked correctly: `localhost`, `0x7f000001`, `2130706433`, `127.1`, dotted mapped form.

**Impact.** An owner or dev can make the server POST JSON to internal addresses. The answer's status code is stored ("The destination answered HTTP 404"), which turns it into a port and service scanner. Limited by what the hosting network can reach and by the JSON POST shape.

**Also:** DNS rebinding. The check resolves the name, then `fetch` resolves it again; a hostname that answers public once and private the next time passes.

**Instances to fix together:** `alerts.ts` `post()` (webhook, Teams, ITSM) and `ticket-notify.ts` `post()` both call the same function; fix the function once, and move it to a shared module. **Fix:** parse IPv6 properly (expand, handle mapped, compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, ULA, link-local, multicast), add the missing IPv4 ranges (`192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4`), and connect to the address that was checked (a custom `lookup` in an undici agent) so it cannot change between check and use. Add tests for every spelling above.

## H2. Windows data folder and service account (High)

**Evidence.** `configure.ps1:33` creates `C:\ProgramData\Kestrel Gateway` and only `gateway.env` gets an ACL (line 77). Default ProgramData ACLs let every local user read files. In that folder: `gateway.db` (the gateway credential, cached device logins in the signed bindings, phone secrets), `admin-code.txt`, `update\request.json`, `update\bundle.zip`, logs. The service has no `serviceaccount` in `service.xml.template`, so it runs as LocalSystem while listening on the network.

**Impact.** On a room PC with a kiosk or shared account, any local user can lift the gateway credential and every device login in the room. The gateway process, which parses device replies and serves HTTP, is running as SYSTEM.

**Fix (everywhere the folder is used):** set the folder ACL to SYSTEM and Administrators (plus the service or tray user) with inheritance removed, on install and on update; run the service as a virtual account (`NT SERVICE\KestrelGateway`) with rights only to its own folders; keep `update\` in an administrator-only location. Store device logins with DPAPI or another OS-protected form rather than plain in SQLite. Give `admin-code.txt` the same ACL.

## H3. The trust anchors live in the cloud (High, architectural)

Three linked facts:
1. **Signing keys come from the cloud.** The gateway stores the public keys the cloud sends at enrolment and replaces them on every config sync (`syncConfig`), unless the operator pinned `KESTREL_PUBLIC_KEY`. A compromised cloud (or an attacker in the TLS path) can hand out its own key and then sign any room release. The signature protects against tampering in storage, not against the server itself. There is no key rotation chain and no rollback protection (an old, validly signed release is accepted).
2. **Update bundles are checked against a digest the cloud supplies** (`GatewayUpdateOrder.bundle.sha256`, decision S-7). Anyone who can change the `gateway-stable` release or hold `GITHUB_RELEASE_TOKEN`, or who compromises the portal, can put code on every gateway. On Windows it is installed as SYSTEM. The download URL is also whatever the cloud returns, with no host check.
3. **Locally**, `update.ps1` (SYSTEM) trusts `request.json` for the zip path and the expected digest, both in the world-creatable data folder (H2). A local user who can create those files when a legitimate update is triggered gets SYSTEM. Expand-Archive is run on the file as it stands.

**Fix:** bake a release-signing public key into the gateway image and installer; sign the bundle digest (and the image) in CI with a key the portal does not hold; have both the gateway and `update.ps1` verify it, including a version floor so old builds cannot be replayed; ship key rotation as statements signed by the old key; only fetch from an allow-listed host; stage updates in an administrator-only folder. This closes S-7. Also sign the Windows installer (Authenticode).

## H4. Panel WebSocket: no Origin check, open by default (High)

**Evidence.** `panel-server.ts` accepts `/ws/:roomId` from any origin. Room access defaults to `open`. The intent set includes `divider.set` (motorised walls), `mover.run` (lifts, screens), camera moves, display keys and power. A web page open in any browser on the customer's LAN can connect to the gateway from that browser (browsers do not apply CORS to WebSockets) and send intents, provided it knows the room id. Since the status page (decision U-1) the room ids are listed on `/`, and the trusted-IP bypass makes panels' own addresses privileged. DNS rebinding would allow reading `/`.

**Fix:** refuse a WebSocket whose `Origin` is not the gateway's own host (and not empty for non-browser panels you own); make PIN the default for new rooms; require re-authentication or a separate tech PIN for `divider.set` and `mover.run`; add `X-Frame-Options`/CSP and `Cache-Control` headers to the panel HTML; consider not listing room ids on the status page unless the requester is a trusted address (see M10).

## Medium findings

**M1. Open redirect (login, signup, invite).** `safeNext` (`apps/web/src/lib/auth-redirect.ts`) rejects `//` and `\` but accepts `/\t/evil.com` and `/\n/evil.com`. The URL parser strips tab and newline, so `new URL('/\t/evil.com', origin)` is `https://evil.com/`. Used by `router.replace(next)` in `login-form.tsx` (and the signup and invite flows). The server-side callback prefixes the origin, so it is not affected. **Fix:** resolve against a dummy origin and require the same origin and no control characters; use the one helper everywhere `next` is read (login form, signup form, invite accept, SSO redirect, callback).

**M2. No security headers.** `next.config.ts` has no `headers()`. Missing: `Content-Security-Policy`, `frame-ancestors`/`X-Frame-Options` (clickjacking on control and destructive buttons), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. (HSTS is added by Vercel on its domains; set it explicitly for a custom domain.) The gateway's new pages already send a strict CSP; the panel server does not. Known as LR-10.

**M3. No effective rate limiting.** The only limiter (`api-keys.ts`) is per server process, which on serverless is close to none, and it runs after authentication. Unlimited and unauthenticated: enrolment, announce, `invite.preview`, webhook hooks, phone join, API-key authentication, sign-up-adjacent tRPC calls (`org.create`, `join-request.create`, which emails owners). Known as LR-9. **Fix:** a shared store (Vercel Firewall rate limits or Redis) keyed by address and by identity; lock out repeated failures on gateway credentials, API keys and hook secrets.

**M4. Panel PIN.** Lockout is per address, in memory, 5 tries a minute: a 4-digit PIN falls to one address in about a day, and to many addresses quickly. The PIN hash is inside the signed manifest that every org member with release access, and every support or provider account, can obtain through the design and release paths; a 4 to 6 digit PIN is trivially cracked offline. **Fix:** require 6+ digits, back off exponentially per room (not per address), keep the hash out of anything a viewer can read, or verify with a keyed hash the gateway holds.

**M5. Phone-control sessions.** A join token is valid 10 minutes and swaps for a 2 hour session that cannot be revoked and permits every panel intent, including the actuator ones, from anywhere on the internet. A photo of the QR code in a meeting room is enough. **Fix:** shorter sessions, revocation (store a session id, kill switch per room and per organisation), limit the intent set, tie the session to the room being in use, and add a per-room switch to turn phone control off.

**M6. Alert email relay.** The email channel accepts up to 10 arbitrary addresses, no verification, on Basic and Pro; the test button sends immediately; the message includes room names and incident text that the organisation controls. Only a per-channel hourly cap applies. **Fix:** verify each recipient (one-time link) or limit to organisation members, cap per organisation, strip or escape user text, and monitor sending.

**M7. Dependencies.** `pnpm audit`: 4 high, 6 moderate. Relevant at runtime: `@fastify/static` 8.3.0 in the gateway (path traversal, route-guard bypass, non-canonical path authorisation bypass; upgrade to the fixed release). I tested traversal against the gateway's `/assets/*` with 8 encodings and it was blocked, so this is a required upgrade, not a demonstrated hole. The rest (`lodash`, `mysql2`, `deepmerge-ts`) arrive through Prisma's CLI tooling, not the running app. **Fix:** upgrade, add `pnpm audit --prod` and Dependabot to CI.

**M8. CI and supply chain.** Actions are pinned by tag (`@v4`, `@v3`, including the one that logs into GHCR with `packages: write`), not commit SHA. `ci.yml` has no `permissions:` block (and the repository default was set to read and write for the release job). No CodeQL, no secret scanning, no Dependabot. Images and the installer are unsigned; `gateway-stable` and `gateway-beta` are overwritten in place. `docker-compose.yml` runs `containrrr/watchtower:latest` (a mutable tag, and that project is no longer maintained: check its status) with the Docker socket mounted, which is root on the host, next to a host-network gateway. **Fix:** pin actions by SHA, set least-privilege `permissions` on every workflow, sign images (cosign) and pin by digest, replace Watchtower with a supported updater or a signed self-update, add CodeQL and secret scanning.

**M9. ReDoS in custom drivers.** `regexProblem` in `driver-spec.ts` only checks that a pattern compiles (300 characters allowed). The gateway runs `new RegExp(...).exec(deviceText)` on its single event loop in `declarative.ts` (lines 29, 136, 289, 300), `generic-tcp.ts` and `serial.ts`; a pattern such as `(a+)+$` against a long reply freezes every room on that gateway. **Fix:** a safe-regex analysis on save, a match-time budget or a worker, or a linear-time engine (RE2); the same check in the browser preview (`driver-example.ts`).

**M10. Gateway local pages (my change, PR #102).** `/admin` is served over plain HTTP on the LAN, so the admin code, the session cookie and pasted enrolment tokens can be read by anyone on the network path; the code protects against a casual visitor, not an attacker on the LAN. `/` lists room ids and names to any LAN host. **Fix options:** serve `/admin` on loopback only by default with an explicit opt-in for the LAN, or add a self-signed HTTPS listener; on `/`, hide ids unless the requester is a trusted address.

**M11. Announce flooding.** 500 open rows globally and 10 new per address per day: an attacker with a handful of addresses can fill the list and block real installs from being claimed (429), and can bury real ones in junk. The address comes from `x-forwarded-for`/`x-real-ip` (correct on Vercel, spoofable anywhere else); the size check trusts `content-length`. **Fix:** evict oldest unseen rows instead of refusing, rank by age, add a proof-of-work or a per-network cap, and read the address only from the platform's trusted header.

**M12. The gateway as a proxy into the customer network.** Roles owner, dev (and support for some calls) can direct the gateway to connect to any host and port through the generic TCP and REST drivers, `test_device` and `verify_point`. That includes `127.0.0.1` (the gateway's own admin page and Watchtower's API on the host), link-local (cloud metadata on a cloud-hosted gateway) and the rest of the LAN. **Fix:** deny loopback, link-local and multicast in the driver layer by default, allow explicit exceptions, and audit the target of each test.

## Low findings and notes

- **L1.** `invite.accept` compares the signed-in email with the invited one but does not require the account's email to be confirmed (the join-request path does).
- **L2.** One key (`KESTREL_SECRETS_KEY`) seals calendar logins, credential sets and claim tokens and derives every room's phone secret. Use per-purpose keys (HKDF) and bind sealed values to their row (AAD) so blobs cannot be swapped. Note that changing it breaks all of them.
- **L3.** Bounds: the heartbeat `rooms` array and `CommandResult.output` have no size cap; telemetry event `at` is gateway-chosen; `manifest()` looks the room up without `orgId` (defence in depth).
- **L4.** Four updates by id after a scoped read (`calendar.ts:50`, `draft.ts:141`, `member.ts:39`, `room.ts:49`) are correct today; use `updateMany` with `orgId` so a later edit cannot break the guarantee.
- **L5.** Support sessions: `staffAccessBlocked` defaults to off, so staff can open a session in any organisation with a reason (the organisation is notified). Consider default-on for enterprise. `orgDirectory` loads every member, room and gateway into memory (a scaling and availability risk).
- **L6.** The calendar jobs call `db.room.findMany({})` across all organisations on every run.
- **L7.** Branding `logoUrl` accepts any URL (including plain `http:` and `data:`), used in `<img>` on panels and the portal: a tracking pixel and mixed-content risk. Restrict to https.
- **L8.** Gateway credential never rotates or expires; `regenerateToken` is the only reset.
- **L9.** Alerts email subject sanitising differs between the three senders (only two strip line breaks). Covered by the DRY sweep, but fix the sanitising first.
- **L10.** `Cache-Control` and clickjacking headers are missing on the panel HTML; the WebSocket accepts up to 4 KB messages with no idle timeout.

## What checked out

- Organisation isolation in the API: `orgProcedure` verifies membership; provider access is default-deny for site-limited grants; support sessions gate read versus act and log acts; staff MFA is required unless `STAFF_REQUIRE_MFA` is exactly `false`. 143 procedures use `orgProcedure`, 2 are public (invite preview, gated by a 192-bit token), 10 are authenticated but user-scoped. A script found no query on an organisation-owned model without `orgId` (four update-by-id calls follow a scoped read).
- Secrets: API keys, enrolment tokens, gateway credentials and hook secrets are stored hashed; sealed values use AES-256-GCM with random nonces; comparisons are constant time; the Stripe webhook verifies the signature on the raw body; the cron endpoints fail closed; device logins are write-only in the portal.
- Nothing committed: no secrets in tracked files or in history for the patterns checked (Stripe, GitHub, AWS, Resend, JWT, private keys, database URLs); `.env*` ignored; `.dockerignore` excludes them; only public values use `NEXT_PUBLIC_`.
- No `eval`, `new Function` or `dangerouslySetInnerHTML`; the gateway image runs as a non-root user; discovery only scans the gateway's own private /24s.

## Recommended plan (nothing started)

1. **Today:** confirm the Data API state; close C1 (RLS migration, revoke, default privileges, CI guard); check API logs; decide on breach handling and rotation. *Needs your permission because it changes the shared database.*
2. **This week (each is small and independent):** H1 the URL filter and its tests; M1 the redirect helper; M2 headers; H2 folder ACL and service account; H4 Origin check and PIN default; M7 dependency upgrade; M8 action pinning, workflow permissions, Dependabot, CodeQL, audit in CI; L1, L3, L4, L7.
3. **Next:** H3 signed releases with a pinned key (the largest piece; touches gateway, updater, CI and the portal); M3 rate limiting on a shared store; M4 to M6, M9 to M12.
4. **Then** the DRY sweep, with the new shared helpers (URL check, redirect helper, ACL setup, audit and email senders) built as part of the fixes so they are not written twice.

Where a fix changes a shared behaviour, it will be applied to every instance listed above in the same change, with a test that fails if a new instance skips it.
