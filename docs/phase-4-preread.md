# Phase 4 Pre-read (cold start) — supersedes phase-1-preread

> Read this + `CLAUDE.md` + `docs/plan.md`. Product = **Kestrel** (repo folder `cobra`). No Avrus/avisor branding anywhere. Progress is NOT tracked in plan.md — this file is the status source.

## Working agreements

- Terse dot-point replies; save tokens. Confirm before starting a big chunk of code if the user hasn't said go
- Git flow: `feat/*`/`fix/*` from `dev` → PR to `dev` → **user merges** → PR `dev` → `main` (user merges). Never commit to `main`/`dev` directly. Trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- Never push/PR/merge unasked. Never commit `.env*`. Multiple sessions have worked in this repo — always check `git log`, branches, `gh pr list` before assuming state

## Status (as of 2026-09-28)

Everything below the phase table, up to and including build steps N to U (Windows installer, Crestron drivers, live-health monitoring, device details, portal-ordered gateway updates, unclaimed gateways, gateway local pages), is on `main`; all 36 migrations are applied. **The table below stops at phase 7 and the first post-phase-7 round; the later work is in `docs/plan.md` (Order table and "Later build steps N to U") and `docs/decisions.md`.**

| Phase | State |
|---|---|
| 0 Foundations | Done, deployed (Vercel `main`, Supabase `kestrel-dev` Sydney) |
| 1 Room modelling | Done, merged (PR #6) |
| Web app shell (extra) | Done, merged (PR #7): shadcn, IBM Plex, `/o/[orgId]/…` routes, invites, team, audit log |
| 2 Engine/simulator/panel UI | Done, merged (PR #8) |
| 3 Gateway | Done, merged (PR #9) |
| 4 Releases & deployments | Done, merged (PR #10), verified in Docker |
| 5 Monitoring & support | Merged with 6 and 7 (`feat/phase-5-monitoring`): health, incidents, alerts (email/Teams/webhook/ITSM stub), allowlisted remote commands + audit, tickets, 90-day retention. Verified end-to-end in Docker + Chrome |
| 6 Billing & customer portal | Merged (same PR): plans/entitlements (trial/basic/pro), Stripe checkout + webhooks, plan gating (since 2026-09-27: Basic is monitoring only, Pro is control plus monitoring, and the gateway's `ControlGate` enforces it; see `docs/decisions.md` TM-1..20), portal control, customer dashboard, org theme, language packs (es/fr/de) |
| 7 Expansion | Merged (same PR): schedule/occupancy/webhook/calendar (M365, Google) triggers, combined rooms, marketplace (publish/review/buy), driver SDK (custom declarative drivers, Pro) + bundled library, serial/REST/VISCA drivers, DM-NVX + Q-SYS drivers, QR-to-phone control, gateway update channels + compose/Watchtower, Windows bundle + installer |
| After phase 7 (merged to `dev` and `main`) | Panel UI redesign (`docs/panel-ui-requirements.md`), room groups (`docs/room-groups.md`; portal and gateway runtime built), staff portal: directory, licences, support sessions, ticket queue, fleet health, marketplace review (`docs/staff-portal-and-msp.md`), service providers (MSPs) incl. site-limited grants. Verified by unit tests, `next build` and `apps/web/scripts/e2e-staff-msp.mts` (70 checks); **not yet clicked through in a browser while signed in** |

### What is verified vs only unit-tested

- **Verified against the real thing:** phases 4 and 5 (Docker gateway image + local cloud, Chrome for the monitoring UI)
- **Unit/integration tests only** (fake clouds, fake devices, in-memory DB helper): billing/Stripe, calendar (Graph/Google), marketplace, combined rooms, driver SDK, NVX, Q-SYS, serial, VISCA, phone control, update channels, Phase 6/7 UI (not opened in a browser)
- **Not run at all:** the portal-ordered update path on a real Windows or Docker gateway (decisions S-3, S-4), the gateway's local admin page on Windows or Docker (U-2), the Windows installer/updater scripts (only parse-checked; the bundle layout was round-tripped with PowerShell 5.1), the Windows CI workflow, the Watchtower compose file (only `config`-validated), the Step N rework (WinSW service, `tray.ps1`'s NotifyIcon, the Inno Setup wizard) — none of it has run on a real Windows machine yet (`docs/decisions.md`, N-1 to N-6)
- Never tested on real hardware: DM-NVX, Q-SYS, PJLink, serial, VISCA, Extron/Cisco/Lutron/Shelly

### Known limitations

- Portal/phone control has up to ~30s first-connect lag (gateway polls on the 30s heartbeat until someone is watching, then every second). No WSS push yet
- Marketplace publisher payouts are not implemented (no Stripe Connect); purchases are one-off Stripe payments to Kestrel
- Gateway-offline detection and calendar polling need an external scheduler (see Ops). Vercel Hobby cron is daily only, so `vercel.json` only has retention
- Calendar triggers use meeting starts only; combined "follow" mirrors activity ids (no cross-room routing model)
- Phone sessions are stateless two-hour tokens: they cannot be revoked, only expire
- Windows update script does not replace itself (the gateway copies its bundled one over the installed one before each update, S-3); `GATEWAY_VERSION` must be bumped per release (CI enforces it) and nothing on the server: the portal reads the newest version from the `gateway-stable` / `gateway-beta` release's `VERSION` file (decision S-9)

## Repo map (added since Phase 0)

- `apps/web` — portal (+ browser simulator); routers: audit, deployment, draft, gateway, invite, member, org, release, room, site, template; server modules `deployment-service`, `deployment-queries`, `gateway-service`
- `apps/gateway` — Node gateway service, `Dockerfile`, README (GHCR image, stable/beta channels)
- `apps/panel` — Vite panel SPA served by gateways (PIN gate, reconnecting WebSocket)
- `packages/model` (room schemas, device catalog, templates, protocol schemas) · `engine` (validator, RoomRuntime, activity planner, executor, design diff) · `drivers` (`sim/` simulated devices, `real/` PJLink, NVX, Q-SYS, generic TCP/serial/REST, VISCA, declarative + bundled `library/`, hybrid real/simulated bus, registry) · `crypto` (Ed25519 signed manifests, tokens, PIN hashing) · `panel-ui` (generated panel) · `db` · `config`
- Migrations: init, room_drafts_templates, members_email_invites, gateway_releases_events, deployments, monitoring, billing_and_control, room_hook_secret, room_combinations, calendars, marketplace, custom_drivers, gateway_channel, room_groups

## Rules learned (don't relearn)

- **Tenancy:** Prisma bypasses RLS. Every org-scoped procedure uses `orgProcedure` (input has `orgId`) and every query filters `ctx.orgId`; verify related ids belong to the org; `requireRole`
- **TypeScript ^6** (typescript-eslint lacks TS7). **Prisma 7.x**, CLI must match client; Prisma 7 doesn't auto-load `.env` (`prisma.config.ts` loads repo-root `.env`; `DIRECT_URL` has placeholder fallback for generate/CI)
- **Migrations:** `pnpm --filter @kestrel/db exec prisma migrate dev --name <x>` locally; commit files; never in Vercel build. Newer migrations may be applied to `kestrel-dev` only — verify before assuming prod parity
- **pnpm 12:** new native/build-script deps must be added to `allowBuilds` in `pnpm-workspace.yaml` or CI/Vercel installs fail (`ERR_PNPM_IGNORED_BUILDS`)
- **Turbo:** env vars listed under `build.env` in `turbo.json`; `@kestrel/db` outputs in `packages/db/turbo.json`
- **Next 16:** `proxy.ts` not middleware; async `cookies()`; `apps/web/AGENTS.md` says read `node_modules/next/dist/docs/` before writing Next code
- **shadcn gotchas:** CLI adds a bogus `cn` npm package and imports from "cn" → fix to `@/lib/utils`, remove dep. `CommandDialog` needs children wrapped in cmdk `<Command>`. Delete `apps/web/.next/types` before `tsc` after deleting routes
- **Shell:** heredoc-heavy Bash can fail in Git Bash — use Write tool. CRLF warnings harmless. Prettier `pnpm format` reformats docs
- **Supabase:** `DATABASE_URL` = transaction pooler 6543; `DIRECT_URL` = session pooler 5432 (direct is IPv6-only); URL-encode password (`/`→`%2F`, `@`→`%40`). Env in repo-root `.env` AND `apps/web/.env.local`
- Design taste: no "AI-slop" UI (big cards, glows); smooth motion on every action; IBM Plex; light default + dark

## Open housekeeping (user side — confirm)

- Rotate Supabase DB password (was pasted in chat)
- Supabase Auth: Site URL + redirect URLs incl. `/auth/callback` (localhost, prod, `https://*-kestrel9.vercel.app/**`)
- Vercel env: `SUPABASE_SERVICE_ROLE_KEY` (member email lookup), DB/Supabase vars for Production + Preview
- Apply new migrations to whichever DB Vercel points at; separate `kestrel-prod` project before customers; Vercel Pro for commercial use; domain for Kestrel unchecked

## Ops (things a person must set up)

- **Env vars** (all in `.env.example`): `KESTREL_SIGNING_KEY(_ID)` (generate with `pnpm --filter @kestrel/crypto keygen`), `CRON_SECRET`, `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `NEXT_PUBLIC_APP_URL`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_PRICE_BASIC`/`STRIPE_PRICE_PRO`, `KESTREL_SECRETS_KEY` (calendar credentials + phone-control secrets), `STAFF_REQUIRE_MFA` / `STAFF_HOST` (optional, staff portal), `GATEWAY_LATEST_STABLE`/`GATEWAY_LATEST_BETA`. Set for Production and Preview on Vercel (`vercel login`, `vercel link` in `apps/web`, then `vercel env add`)
- **Scheduled jobs** (authorise with `Authorization: Bearer $CRON_SECRET`): `GET /api/cron/retention` (daily, in `vercel.json`), `GET /api/cron/sweep` (every 1-2 min: marks silent gateways offline and raises incidents), `GET /api/cron/calendar` (every 1-5 min). Use an external scheduler, Vercel Pro cron, or Supabase `pg_cron` + `pg_net`
- **Stripe:** webhook endpoint `/api/stripe/webhook` (subscription + checkout events); create Basic and Pro prices
- **Migrations:** apply to any DB other than `kestrel-dev` (`prisma migrate deploy`)
- **Gateway releases:** bump `GATEWAY_VERSION` in `apps/gateway/src/config.ts`; `main` publishes the `stable` image + Windows bundle, `dev` the `beta` ones

## MVP gaps

- Real-hardware runs (DM-NVX, Q-SYS) and "gateway runs a room against real devices, panel on LAN offline" are unverified
- Deploy/monitoring UIs for phases 6-7 have not had a browser pass

## Suggested next steps (in order)

1. Work through "Next steps by dev" in `docs/plan.md` (secrets, Vercel env vars, scheduler, Stripe, real gateway and hardware)
2. Then "Next build steps" at the very end of `docs/plan.md`: a browser pass of the new screens, quick actions from drivers, the room groups gateway runtime, audit retention and export, panel function pages, and the rest. Each step lists its own pre-read
