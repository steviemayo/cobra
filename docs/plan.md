# Kestrel — Build Plan (phased)

> Proposed. Each phase ends in something demoable. MVP = Phases 0–4 (+ thin slice of 5).

## Key Architectural Bets

- **One engine, two hosts:** `packages/engine` (pure TS, no IO) runs on gateway AND in browser simulator → what you simulate is what deploys
- **Model → Manifest → Runtime:** authoring model (DB) compiles to a signed JSON manifest; gateway only ever interprets manifests
- **Drivers behind a contract:** `connect / send / parse / feedback (incl. signal-presence) / health`; simulated devices implement same contract
- **Protocol in `packages/model`:** versioned zod schemas for heartbeat, commands, deploy, telemetry
- **Panel UI is static SPA + manifest:** gateway serves it, WS for state; multiple panels follow room state

## Phase 0 — Foundations

- Turborepo + pnpm, TS strict, eslint/prettier, vitest, GitHub Actions CI (lint/typecheck/test)
- Supabase project (Sydney) + Prisma; Vercel project; env/secret handling
- Supabase Auth, org/membership/roles, tRPC context with tenant scoping
- Base Prisma schema: Org, Member, Site, Gateway (stub), Room (stub), AuditLog
- **Done when:** sign up → create org → site → room record; deployed on Vercel preview

## Phase 1 — Room Modelling (portal)

- `packages/model` schemas: Device, Port, Connection, Group, State, Action, Activity, Trigger
- Catalog of device categories + Room Types (Meeting, Training) + starter templates
- Authoring UI: add devices, define ports/connections, groups, states, activities (list + graph view)
- Validator: unconnected ports, illegal routes, missing capabilities, missing drivers
- Versioned drafts (autosave), template create/clone (org-level)
- **Done when:** build the "90% room" in portal, validator passes, model saved

## Phase 2 — Engine + Simulator + Generated UI

- `packages/engine`: routing graph resolver, group modes, activity generator (capability-filtered), action executor (parallel + dependency-aware, deterministic readiness), auto-behaviours (signal detect, conflict prompt 10s, idle warn 30s)
- Simulated devices (display, matrix, DSP, camera, source, recorder) in `packages/drivers`
- `packages/panel-ui`: generated intent UI (nav groups, volume +/-, plain-language status, themes, i18n scaffolding)
- Browser simulator: panel UI beside animated signal-flow/device-state view
- **Done when:** demo "Present Laptop" and "Record" in browser; multi-panel follow works

## Phase 3 — Gateway

- `apps/gateway`: enrollment (token → credential), heartbeat 30s, WSS push w/ HTTPS fallback, config sync
- Room runtime host (per-room isolation), driver loader, generic TCP/serial + PJLink, panel UI server (WS), optional PIN + trusted IP
- SQLite buffer for events/telemetry + offline boot from local manifest cache
- Dockerfile + GHCR build; Windows installer deferred
- **Done when:** container enrols, runs a room against simulated + 1–2 real devices, panel on LAN works offline

## Phase 4 — Releases & Deployments

- Release = immutable snapshot → manifest → hash + signature → Supabase Storage
- Deployment per room: on-demand + scheduled; state machine (download → verify → stage → health check → active/rollback)
- Drift/pending detection (cloud vs desired vs reported), rollback to previous release
- Deploy UI: status, logs, diff between releases
- **Done when:** publish → deploy → panel changes live; break it → auto rollback; drift flagged

## Phase 5 — Monitoring & Support

- Telemetry ingest, device/room health scoring, events, incidents, 90-day retention job
- Portal live status (Supabase Realtime), room/site/gateway dashboards
- Alerts: email, Teams, webhook, ITSM placeholder; rules + noise control
- Remote commands (allowlist) + audit log; tech/support view in portal; tickets/support requests
- **Done when:** unplug a device → incident + alert; run diagnostic remotely

## Phase 6 — Billing & Customer Portal

- Stripe: per-room subscription, Trial (5 rooms/30d) → downgrade logic, Basic, Pro; webhooks; entitlements middleware
- Customer viewer role + customer dashboard (status, control, tickets)
- Org theming (logo/colours), language packs

## Phase 7 — Expansion

- Triggers: schedule, calendar (Graph/Google), occupancy, webhook/API
- Combined rooms behaviour (room groups built: `docs/room-groups.md`; the first primary/secondary version is removed)
- Marketplace (publish/buy templates), driver SDK + dev subscription
- Gateway self-update channels, Windows installer, QR-to-phone control
- Additional drivers (conference systems API control, cameras, env, mechanical)

## MVP Proposal (confirm)

- 1 gateway (Docker), 1 Meeting room: 2 laptops → matrix → 2 displays + DSP
- Present Laptop / Room Off activities, auto signal-detect (fake or simulate)
- Deploy + rollback, live status, simulator in browser
- Real hardware: generic TCP/serial + PJLink + Crestron DM-NVX virtual matrix (1 DM-NVX-E30 encoder and 1 DM-NVX-D30 decoder) + ONE DSP (1 x Qsys Core with a gain component with script name 'gain')

## Suggested Tech Picks [A — confirm]

- pnpm + Turborepo, zod, Vitest, tRPC v11, TanStack Query, shadcn/ui (Tailwind)
- Gateway: Fastify + ws + better-sqlite3 + pino
- Panel UI: Vite + React (or Preact for small footprint), served statically by gateway
- Signing: Ed25519 (node crypto); private key in Vercel secret/KMS, public key baked into gateway
- Graph editor: React Flow (device/connection view)
- i18n: next-intl (portal) / i18next (panel)

## Immediate Next Steps (on go-ahead)

1. Scaffold monorepo + CI (Phase 0)
2. Write `packages/model` first draft (Phase 1 schemas) — this is the contract everything else depends on
3. Prisma schema v1

## Next steps by dev

Everything the code needs is built. What is left is setup that only you can do (accounts, secrets, merging) and checks on real machines. Do them roughly in this order; each step says why, what to do, and how to tell it worked. Terminal commands are for Windows PowerShell unless they say otherwise. Anything in `<angle brackets>` is a value you fill in.

Words used below:

- **Env var**: a named setting (like `CRON_SECRET`) the app reads at runtime. Locally they live in `.env` at the repo root (never committed). On the internet they live in Vercel's settings.
- **Production vs Preview**: Vercel runs two kinds of deployments. Production is what `main` builds. Preview is what every pull request builds. Each has its own set of env vars, so most vars are added twice.
- **Migration**: a numbered SQL file in `packages/db/prisma/migrations` that changes the database layout. Each database (dev, prod) must have every migration applied, in order.

### 0. Where things stand (read once)

- All phases are built and merged to `dev` and `main` (PRs #9, #10 and the phases 5 to 7 PR). CI on them is green. What follows is setup and real-world checks that need you.
- Use `docs/phase-4-preread.md` as the status source, and `.env.example` as the list of every env var.
- **Status check on 2026-09-25** (checked with the Vercel, Supabase, GitHub and Prisma CLIs; secret values were not read). Production URL until a domain exists: `https://kestrel-lovat.vercel.app`. There is one database, `kestrel-dev`, used by Production and Preview alike.

| Step | Status | Notes |
|---|---|---|
| 1. Secrets | Done | `KESTREL_SIGNING_KEY`, `_ID`, `CRON_SECRET`, `KESTREL_SECRETS_KEY` are on Vercel (Production + Preview) and in `.env` |
| 2. Vercel env vars | Done (except Stripe) | See "Added to Vercel" below; redeploy needed |
| 3. Migrations | Done | `prisma migrate status`: 13 migrations, "Database schema is up to date". Supabase CLI linked to `ntamimcbktoyvgvwesii` |
| 4. Supabase housekeeping | **Unverified** | Password rotation and auth redirect URLs cannot be checked from the CLI. Confirm in the Supabase dashboard |
| 5. Scheduled jobs | **Unverified** | Not tested. Run the `curl.exe` check in step 5 against `https://kestrel-lovat.vercel.app` and confirm the job exists in cron-job.org |
| 6. Resend | Deferred | No domain yet. `RESEND_API_KEY` and `ALERT_FROM_EMAIL` are in local `.env` only, not on Vercel |
| 7. Stripe | Deferred | Set up later |
| 8. Marketplace review | Ready to try after redeploy | Now in the staff portal at `/staff/marketplace`; you are seeded as staff admin. Set up your authenticator app the first time |
| 9. Gateway release | **Partly** | CI green on `main`, `:stable` and `:beta` images publicly pullable, `gateway-stable` release exists, workflow permissions are read/write. `GATEWAY_LATEST_*` now set on Vercel. No `gateway-beta` release was listed, check it |
| 10 to 14 | Not started | Not a priority for now |

**Added to Vercel on 2026-09-25** (Production and Preview): `NEXT_PUBLIC_APP_URL` (`https://kestrel-lovat.vercel.app`), `KESTREL_ADMIN_EMAILS` (no longer used: delete it from Vercel), `GATEWAY_LATEST_STABLE` and `GATEWAY_LATEST_BETA` (`0.1.0`), `NEXT_PUBLIC_GATEWAY_IMAGE`, and `RESEND_API_KEY` and `ALERT_FROM_EMAIL` (copied from local `.env`; email will not send from a real domain until step 6 is done).

Still to add later: the four `STRIPE_*` vars (step 7). When a domain exists, update `NEXT_PUBLIC_APP_URL`.

Env vars only apply to new deployments, so redeploy Production after adding any.

### 1. Generate the secrets

Three values need creating. Run each and keep the output somewhere private (a password manager), not in chat or git.

| Env var | What it is | How to make it |
|---|---|---|
| `KESTREL_SIGNING_KEY`, `KESTREL_SIGNING_KEY_ID` | The private key Kestrel signs room releases with. Gateways refuse anything not signed by it. | Already generated: they are in your local `.env` (made by `pnpm --filter @kestrel/crypto keygen`). Use the same values on Vercel. |
| `CRON_SECRET` | A password that scheduled jobs present to `/api/cron/*`. 16+ characters. | `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
| `KESTREL_SECRETS_KEY` | Encrypts calendar logins and derives the secrets behind phone (QR) links. Exactly 32 random bytes, base64. | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

Rules that matter:

- **Never lose or change `KESTREL_SIGNING_KEY` casually.** Gateways trust the matching public key. To rotate it later, keep the old public key in `KESTREL_EXTRA_PUBLIC_KEYS` (see `.env.example`) until every gateway has updated.
- **Changing `KESTREL_SECRETS_KEY` breaks stored calendar connections** (they must be re-entered) and invalidates open phone links. Set it once.
- Add all three to your local `.env` too if you want to run the features locally.

### 2. Put the env vars on Vercel

Docs: https://vercel.com/docs/cli and https://vercel.com/docs/environment-variables

1. Install and sign in. Your Vercel team is `kestrel9`, project `kestrel`.
   ```powershell
   npm i -g vercel
   vercel --version
   vercel login          # opens a browser; approve it
   ```
2. Link this folder to the project (once). Say yes to "link to existing project", pick `kestrel9` / `kestrel`.
   ```powershell
   cd apps\web
   vercel link
   ```
3. Add each variable for **production** and again for **preview**. The command asks you to paste the value (it does not echo it):
   ```powershell
   vercel env add KESTREL_SIGNING_KEY production
   vercel env add KESTREL_SIGNING_KEY preview
   ```
   Repeat for every name in the table below. When it asks which git branch for preview, leave it blank so it applies to all.
   Or use the dashboard instead: Vercel > your project > **Settings** > **Environment Variables** > **Add** (tick Production and Preview).
4. List what is set (names only) and redeploy so the new values take effect:
   ```powershell
   vercel env ls
   ```
   Env vars only apply to deployments made **after** they are added. In the dashboard: **Deployments** > the latest one > **...** > **Redeploy**.

Full list (from `.env.example`). "Now" means set it before anything else works; the rest are set as you reach their step below.

| Name | When | Value |
|---|---|---|
| `KESTREL_SIGNING_KEY`, `KESTREL_SIGNING_KEY_ID` | now | from your local `.env` |
| `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | now (check they exist) | see `docs/getting-started.md` |
| `NEXT_PUBLIC_APP_URL` | now | your real public URL with no trailing slash, e.g. `https://<your-domain>`. Used for links in alert emails and Stripe return links |
| `CRON_SECRET` | now | step 1 |
| `KESTREL_SECRETS_KEY` | now | step 1 |
| `STAFF_REQUIRE_MFA`, `STAFF_HOST` | optional | leave both unset in production. See `docs/staff-portal-and-msp.md` |
| `RESEND_API_KEY`, `ALERT_FROM_EMAIL` | step 6 | Resend |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO` | step 7 | Stripe |
| `GATEWAY_LATEST_STABLE`, `GATEWAY_LATEST_BETA` | step 9 | newest gateway version per channel, e.g. `0.1.0` |
| `NEXT_PUBLIC_GATEWAY_IMAGE` | optional | e.g. `ghcr.io/steviemayo/kestrel-gateway:stable`, shown in the "add gateway" instructions |

Working when: the **Vercel preview for PR #9** builds, and opening a preview URL loads `/login`. (The three preview checks from PR #9 need the signing key: sign in, create a room, deploy a release; a deploy that fails with "Release signing is not configured" means the key is missing on that environment.)

Note: Vercel's free (Hobby) plan is for non-commercial use. Before real customers, move to Pro (https://vercel.com/pricing).

### 3. Apply the new database migrations

The dev database (`kestrel-dev`) already has all 13 migrations because I ran them there. Any **other** database, especially the one production uses, needs them applied. Never do this in a Vercel build.

1. Check which database Vercel production points at: Vercel > Settings > Environment Variables > `DIRECT_URL` (the host tells you which Supabase project).
2. If it is a different project from `kestrel-dev`, apply them from your machine, pointing at that database only for this one command (`DIRECT_URL` is the **session pooler** URL, port 5432, from Supabase > **Connect**; URL-encode special characters in the password, `/` becomes `%2F`, `@` becomes `%40`):
   ```powershell
   $env:DIRECT_URL = "postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres"
   pnpm --filter @kestrel/db exec prisma migrate status     # should list the ones still pending
   pnpm --filter @kestrel/db exec prisma migrate deploy
   Remove-Item Env:DIRECT_URL
   ```
   `migrate deploy` only applies committed migrations and never resets data. The docs: https://www.prisma.io/docs/orm/prisma-migrate/workflows/production-and-testing-environments
3. Working when: `migrate status` says "Database schema is up to date".

Current setup: only `kestrel-dev` exists and both Production and Preview use it, so nothing more is needed here yet.

Better long term: make a separate `kestrel-prod` Supabase project (Sydney) before real customers, keep `kestrel-dev` for development, and point Vercel Production at prod and Preview at dev.

### 4. Supabase housekeeping

1. **Rotate the database password** (it was pasted into a chat earlier): Supabase > Project Settings > **Database** > **Reset database password**. Then update `DATABASE_URL` and `DIRECT_URL` in `.env`, `apps/web/.env.local` and Vercel (step 2), and redeploy.
2. **Auth redirect URLs**: Supabase > **Authentication** > **URL Configuration**. Set Site URL to your production URL. Add Redirect URLs: `http://localhost:3000/auth/callback`, `https://<your production domain>/auth/callback`, and `https://*-kestrel9.vercel.app/**` (covers previews). Docs: https://supabase.com/docs/guides/auth/redirect-urls
3. Working when: signing up or resetting a password from the production site lands back in the app.

### 5. Run the scheduled jobs

Two jobs must be called every minute or two from *outside* Vercel, because the free plan only allows one cron per day (the daily data-retention job is already in `apps/web/vercel.json`).

- `GET https://<app>/api/cron/sweep` every 1 to 2 minutes. Notices gateways that went quiet (a dead gateway cannot report itself) and raises the "gateway offline" incident and alert. Without it, offline alerts never fire.
- `GET https://<app>/api/cron/calendar` every 1 to 5 minutes. Starts rooms for calendar meetings. Only needed if you use calendar triggers.
- Both need the header `Authorization: Bearer <CRON_SECRET>`.

Pick **one** way:

**A. cron-job.org (simplest, free, 1-minute interval).** https://cron-job.org
1. Create an account, then **Create cronjob**.
2. URL `https://<app>/api/cron/sweep`, schedule "Every 1 minute".
3. Under **Advanced** > **Headers** add key `Authorization`, value `Bearer <CRON_SECRET>`.
4. Save, repeat for `/api/cron/calendar` (every 2 minutes is fine).

**B. Supabase pg_cron (no extra account).** Docs: https://supabase.com/docs/guides/database/extensions/pg_cron and https://supabase.com/docs/guides/database/extensions/pg_net
1. Supabase > **Database** > **Extensions**: enable `pg_cron` and `pg_net`.
2. Supabase > **SQL Editor**, run (replace both placeholders):
   ```sql
   select cron.schedule('kestrel-sweep', '* * * * *', $$
     select net.http_get(
       url := 'https://<app>/api/cron/sweep',
       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
     )
   $$);
   ```
   The secret is stored readable in the `cron.job` table, so this is fine for a private project but option A or a Vercel Pro cron is tidier.

Working when: this returns `{"alerts":0}` (test it; a wrong secret gives 401):
```powershell
curl.exe -H "Authorization: Bearer <CRON_SECRET>" https://<app>/api/cron/sweep
```

### 6. Email alerts (Resend)

Alerts by email need a sender. Teams and webhook alerts do not.

**Deferred (no domain yet).** Resend account and API key exist locally. Until a domain is verified, email alerts can only be tested to your own address via `onboarding@resend.dev`; leave the two vars off Vercel so email channels are skipped. Resume at item 1 once the domain is bought.

1. Sign up at https://resend.com, then **Domains** > add your domain and add the DNS records it shows (https://resend.com/docs/dashboard/domains/introduction). Wait until it says Verified. (You cannot send from a domain you have not verified; testing with Resend's `onboarding@resend.dev` sender only delivers to your own email.)
2. **API Keys** (https://resend.com/api-keys) > create one with "Sending access".
3. Set `RESEND_API_KEY` to it and `ALERT_FROM_EMAIL` to an address on your verified domain, e.g. `alerts@<your domain>` (step 2).
4. Working when: in the portal, **Alerts** > add an email channel > send a test, and it arrives.

### 7. Billing (Stripe)

**Deferred, set up later.** Until then billing pages will not work; nothing else depends on it.

Do this in Stripe **test mode** first (toggle at the top right of the dashboard). Real cards are not charged in test mode. Docs: https://docs.stripe.com/billing/subscriptions/build-subscriptions

1. Sign up at https://dashboard.stripe.com. Keep **Test mode** on.
2. **Products** > add product **Kestrel Basic**: recurring, monthly, price per unit (per room), e.g. `10.00 AUD`. Copy the **price** id (starts `price_`) to `STRIPE_PRICE_BASIC`. Repeat for **Kestrel Pro** into `STRIPE_PRICE_PRO`. Kestrel sets the quantity to the number of rooms itself.
3. **Developers** > **API keys** (https://dashboard.stripe.com/test/apikeys): copy the **Secret key** (`sk_test_...`) into `STRIPE_SECRET_KEY`.
4. **Developers** > **Webhooks** > **Add endpoint** (https://dashboard.stripe.com/test/webhooks): URL `https://<app>/api/stripe/webhook`, and select these events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed`. After saving, click **Reveal** on the **Signing secret** (`whsec_...`) and put it in `STRIPE_WEBHOOK_SECRET`.
5. Set the four env vars (step 2) and redeploy.
6. Working when: in the portal, **Settings > Billing** > choose a plan > pay with Stripe's test card `4242 4242 4242 4242` (any future expiry, any CVC). You return to the billing page showing the plan, and the Stripe dashboard shows a subscription. Add a room and the quantity in Stripe goes up by one.
7. To try webhooks against your **local** machine instead: install the Stripe CLI (https://docs.stripe.com/stripe-cli), run `stripe listen --forward-to localhost:3000/api/stripe/webhook`, and use the `whsec_` it prints as `STRIPE_WEBHOOK_SECRET` in `.env`.
8. Going live later: repeat with **Test mode off** (new products, keys, webhook), swap the values in Production only, and read https://docs.stripe.com/get-started/checklist/go-live.

Not built: paying marketplace publishers (needs Stripe Connect, https://docs.stripe.com/connect). Purchases are one-off payments to Kestrel.

### 8. Marketplace review

Publishing is limited to Pro orgs, and a listing is invisible until a Kestrel admin approves it. Kestrel staff review listings in the staff portal: sign in as a staff user (add one with `apps/web/scripts/add-staff.mts`), enter your authenticator code, and open `https://<app>/staff/marketplace` to approve or reject. Working when: you publish a template from **Templates** in a Pro org, approve it there, and it shows in **Marketplace** for another org.

### 9. Ship a gateway release (Docker images and Windows bundle)

GitHub Actions builds these for you when code is pushed:

- `main` publishes the Docker image `ghcr.io/steviemayo/kestrel-gateway:stable` and the Windows bundle release `gateway-stable`.
- `dev` publishes `:beta` and `gateway-beta`.

One-time setup:

1. **Make the image pullable.** GitHub profile > **Packages** > `kestrel-gateway` > **Package settings** > **Change visibility**. Public is simplest; if private, machines need `docker login ghcr.io` with a token that has `read:packages` (https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
2. **Windows bundle releases need the repo to allow workflow writes**: GitHub repo > **Settings** > **Actions** > **General** > **Workflow permissions** > "Read and write permissions". The bundle workflow only runs once on `main`/`dev` after the merge in step 0; check the **Actions** tab shows "Gateway Windows bundle" green, then **Releases** shows `gateway-stable`.
3. **Each time you release a new gateway version:** bump `GATEWAY_VERSION` in `apps/gateway/src/config.ts`, merge, and set `GATEWAY_LATEST_STABLE` (or `_BETA`) on Vercel to the same number. The portal uses that to show "Update available" on older gateways.

### 10. Try a gateway on a real machine

Do the **Docker** route first, on any Linux or Windows machine with Docker on the same network as your room devices (https://docs.docker.com/get-started/get-docker/).

1. In the portal: **Gateways** > **Add gateway** > name it, pick the site. Copy the one-time **enrolment token** it shows (valid 24 hours, shown once).
2. On the machine, copy `apps/gateway/docker-compose.yml` to a folder and add a `.env` next to it:
   ```
   KESTREL_CLOUD_URL=https://<app>
   KESTREL_ENROLL_TOKEN=<token>
   KESTREL_CHANNEL=stable
   KESTREL_IMAGE=ghcr.io/steviemayo/kestrel-gateway
   ```
   then `docker compose up -d`. This also starts Watchtower, which updates the gateway automatically.
3. Working when: the gateway shows **Online** in the portal within about a minute, and `docker compose logs gateway` shows "Enrolled with the cloud". Assign a room to it, deploy a release, and open `http://<machine>:8080/room/<room id>` on a tablet on the same network to see the panel.
4. If it does not connect: `docker compose logs gateway` prints the reason. A wrong `KESTREL_CLOUD_URL` or an expired token are the usual causes (use **Re-enrol** in the gateway's **...** menu for a new token).

**Windows** route (test once on a clean Windows VM or spare PC, since I could only syntax-check these scripts): needs step 9 done so the `gateway-stable` release exists. In an **administrator** PowerShell, after downloading `install.ps1` from the repo's `apps/gateway/windows` folder:
```powershell
.\install.ps1 -CloudUrl https://<app> -EnrollToken <token>
```
Working when: the gateway shows Online, `Get-ScheduledTask "Kestrel Gateway*"` lists two tasks, and logs appear in `C:\ProgramData\Kestrel Gateway\logs\gateway.log`. Undo with `& "C:\Program Files\Kestrel Gateway\uninstall.ps1"`. If something fails, send Claude the error and the log.

### 11. Test with real room hardware

Nothing has been run against real devices yet, so budget time for surprises. Do this on the gateway from step 10, with the machine on the same network as the devices.

1. In the room's **Devices** panel, set each device's IP or port and pick its driver. First try just one device at a time.
2. **Crestron DM-NVX** (E30 encoder, D30 decoder): needs the device's IP and the login the units are configured with. Make the room a virtual matrix, then use **Simulate** vs the real panel to compare. Manuals and the control reference are on Crestron's support site (https://www.crestron.com, search "DM-NVX-E30" and "DM-NVX-D30").
3. **Q-SYS Core**: enable **External Control Protocol** on the Core (Q-SYS Designer > the Core's properties), and give the gain component the script name `gain`. Reference: https://q-syshelp.qsc.com (search "QRC" or "External Control Protocol").
4. **Displays**: PJLink projectors and displays need PJLink enabled in their network menu (usually port 4352).
5. In the portal check **Monitoring** shows each device online, then press an activity on the panel and watch the device react.
6. **Offline test** (the Kestrel promise): unplug the gateway's internet, confirm the panel still works, plug it back in, and confirm telemetry catches up.
7. Anything that fails: copy the gateway log (`docker compose logs gateway`) and the device name to Claude; drivers are quick to adjust once we see the real replies.

### 12. Calendar triggers (optional, per customer)

A customer's owner connects their calendar under **Settings > Calendars**, then rooms with a calendar trigger start when a meeting begins. It reads room mailboxes only.

**Microsoft 365** (docs: https://learn.microsoft.com/graph/auth-v2-service):
1. Azure portal (https://portal.azure.com) > **Microsoft Entra ID** > **App registrations** > **New registration**. Note the **Directory (tenant) ID** and **Application (client) ID**.
2. **Certificates & secrets** > **New client secret**; copy the value at once.
3. **API permissions** > **Add a permission** > Microsoft Graph > **Application permissions** > `Calendars.Read`, then **Grant admin consent**.
4. In Kestrel: **Settings > Calendars** > Microsoft 365, paste tenant id, client id, client secret. It signs in once to check them.
5. In the room's trigger, use the room mailbox address (for example `boardroom@customer.com`) as the calendar id.

**Google Workspace** (docs: https://developers.google.com/workspace/guides/create-credentials#service-account):
1. Google Cloud console > create a project > enable the **Google Calendar API** > **IAM & Admin** > **Service accounts** > create one > **Keys** > **Add key** > JSON. Keep the file private.
2. Share each room's calendar with the service account's email (Calendar settings > **Share with specific people** > "See all event details").
3. In Kestrel: **Settings > Calendars** > Google, paste the JSON's `client_email` and `private_key`.

Working when: a meeting starting in a test room mailbox starts the room's activity within about two minutes (needs the `/api/cron/calendar` job from step 5).

### 13. A walk through the screens I could not open

I have never opened these while signed in. Use a test org and click through, and tell Claude (or note here) anything that looks wrong or errors:

- **Settings > Billing** `/o/<org>/settings/billing` (choose plan, Stripe test card, trial banner)
- **Marketplace** `/o/<org>/marketplace`, **Templates** (publish), `/staff/marketplace` (approve)
- **Drivers** `/o/<org>/drivers` (create a custom driver from the example; Pro only), and the driver picker in a room's **Devices**
- **Combinations** `/o/<org>/combinations`, then a room's **Control** page for the join/split bar
- **Gateways** `/o/<org>/gateways` (channel badge, "Follow the beta channel" in the **...** menu)
- **Monitoring**, **Incidents**, **Alerts**, **Tickets**, room **Control**, **Settings** (theme, language, calendars)
- **Phone control**: on a running gateway's panel, tap the phone button bottom-left, scan the QR code with a phone, and control the room from it (needs `KESTREL_SECRETS_KEY` set on Vercel, step 1).

### 14. Decisions still yours

- Confirm the **MVP definition** (bottom of the earlier section of this file).
- Pick the **first vendors** for matrix, DSP, display and camera drivers beyond NVX/Q-SYS.
- Check the **domain**: is `kestrel` available? Point it at Vercel (Settings > Domains) and update `NEXT_PUBLIC_APP_URL` and the Supabase URLs (step 4).
- Create a separate **`kestrel-prod`** Supabase project and a **Vercel Pro** plan before real customers.

---

## Next build steps (after the panel redesign, room groups, staff portal and providers)

Written 2026-09-26. Everything above this line is set-up and verification for what was built in phases 0 to 7. This section is what to build next.

**Status at the end of 2026-09-26:** B, C, D (part 1), E, F, G, H, I, J and K are built and merged to `dev` (each step below says what was and was not done; every decision made along the way is in `docs/decisions.md`). What is left:

- **A**: the browser pass. Yours: nothing built this round has been clicked through signed in, or run on real hardware
- **Before the release PR `dev` to `main`**: apply the two migrations added this round with `pnpm --filter @kestrel/db exec prisma migrate deploy` (`20260926120000_divider_actions`, `20260926140000_org_retention`). They were not applied by the build. Then set `STAFF_TICKET_EMAIL` (and `RESEND_API_KEY`, `ALERT_FROM_EMAIL` once the sending domain exists) if you want email
- **Driver classes slice 2**: apply migration `20260926180000_bindings_and_credentials` (two new tables, `Gateway.features`, `Room.reportedBindingsVersion`) with `prisma migrate deploy` **before** the release to `main`. Set `KESTREL_SECRETS_KEY` on the server if it is not already (logins cannot be stored without it). Update gateways to use binding-only releases; older gateways keep getting the merged values
- **Driver classes slice 6**: apply migration `20260926200000_site_devices` (new `SiteDevice` table and `Release.siteDeviceIds`) the same way, **before** the release to `main`
- ~~**D part 2**: drop the `RoomCombination` table~~ done (migration `20260926160000_drop_room_combination`, table was empty)
- **L**: needs your decision on who pays (the provider, the customer, or per customer)
- **M**: WSS push needs a host that can hold connections (Vercel functions cannot), Stripe Connect needs a Stripe account and payout rules, third-party drivers and sandboxed hooks each need a security design first
- Left out on purpose in F: camera auto-tracking and a separate recorder page. Left out in K: notifications as a target nears, per-organisation targets, business hours

### How to start any of these (read first, in this order)

1. `CLAUDE.md` (project rules; note the panel and combined-rooms lines)
2. `docs/phase-4-preread.md` (status, working agreements, known limitations)
3. The pre-read listed under the step you are doing (each step lists its own)
4. `docs/staff-portal-and-msp.md` for anything about staff, providers, tickets or licences (its "Build status" says what exists)
5. `docs/panel-ui-requirements.md` for anything on the room panel
6. `docs/room-groups.md` for anything on combined rooms

Working rules that apply to all of them:

- Branch from `dev` (`feat/...`), PR to `dev`, merge when CI is green, then a release PR `dev` to `main`. Conventional commits. Never commit `.env*`
- **Migrations are additive first.** Previews and production share one database (`kestrel-dev`), so a release must never drop or rename something the running production code still reads. Add, deploy, then remove in a later release. Generate SQL offline with `prisma migrate diff --from-schema <old> --to-schema <new> --script`, apply with `prisma migrate deploy`
- Check before finishing: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and for web changes `pnpm --filter @kestrel/web build`. For access, staff or provider changes also run `apps/web/scripts/e2e-staff-msp.mts` (70 checks against the dev database; see its header)
- Only format the files you changed (`prettier --write <files>`), never a whole folder
- Anything reachable by a customer goes through `orgProcedure` and filters by `ctx.orgId`. Anything a site-limited provider may reach must declare `.meta(SITE_SCOPED)` and apply `ctx.siteScope`

### Order

| # | Step | Size | Needs from you |
|---|---|---|---|
| A | Browser pass of the new screens (below) | small | you, with an authenticator app and two accounts |
| B | Quick actions from drivers (Blank Screen, Privacy Mute) | medium | a display or projector that supports blank, to try |
| C | Room groups: gateway runtime (R1 to R4) | large | **built** (decisions in `docs/decisions.md`) |
| D | Remove the old combinations code and table (R5) | medium | code removal **built**; table drop waits for the release |
| E | Audit retention and export | medium | **built** (default 12 months, see `docs/decisions.md`); apply migration `org_retention` |
| F | Panel function pages (cameras, microphones, recorder, room controls) | large | **built** except tracking and a recorder page (`docs/decisions.md`, F-1 to F-9); try on real devices |
| G | Org accent colour in the portal | small | **built** (`docs/decisions.md`, G-1 to G-4) |
| H | Email notifications (tickets and alerts) | small | **built**, sends once Resend is set up (`docs/decisions.md`, H-1 to H-6) |
| I | Staff user management and a staff audit viewer | small | **built** (`docs/decisions.md`, I-1 to I-6) |
| J | Assign tickets to provider people | medium | **built** (`docs/decisions.md`, J-1 to J-6) |
| K | SLAs and priority timers | medium | **built** early (`docs/decisions.md`, K-1 to K-7); confirm the default targets with a first customer |
| L | Provider billing and white label | large | a business decision on who pays |
| M | Earlier candidates: WSS push, Stripe Connect payouts, third-party drivers, sandboxed logic hooks | large each | see `docs/phase-4-preread.md` |
| N | Windows gateway download from the Gateways page | small | **built** (header button and enrolment dialog; `NEXT_PUBLIC_GATEWAY_WINDOWS_URL`). Needs the `gateway-stable` release asset to be downloadable without a GitHub sign-in: on 2026-09-26 it answered 404 to a signed-out request (private repo), so publish the zip somewhere public or serve it through the portal |

Do A first: nothing from the last round has been clicked through while signed in. Then B and C are the highest value.

---

### A. Browser pass of what was just built (you)

Not done. The logic is covered by unit tests and by `apps/web/scripts/e2e-staff-msp.mts`, which calls the router directly, so it does not cover sign-in, the second-factor page or the layouts.

Pre-read: `docs/staff-portal-and-msp.md` (Build status), `docs/panel-ui-requirements.md` (Build status).

Do, on the production or preview URL:

1. Sign in, open `/staff`. The first time it sends you to `/staff/mfa`: scan the QR code with an authenticator app and enter the code. Working when: you land on **Organisations**
2. Staff: open an organisation, add a note, adjust a licence (try **Extend trial 14 days**), then start a **view-only** session with a reason. Working when: the yellow banner counts down, changes are refused with a clear message, and **End session** returns you to `/staff/orgs`
3. Providers: create a second account, create an organisation ticked **We are a managed service provider**. In a customer organisation open **Settings > Service providers**, paste the provider's code (shown on the provider's **Customers** page), invite it for one site only, accept as the provider. Working when: the provider sees only that site's rooms, gateways, monitoring and support requests, and anything else says access is limited to specific sites
4. Tickets: raise a request about a room at that site (it should show "With service provider"), escalate one to Kestrel, then reply from `/staff/tickets`. Working when: the reply shows as **Kestrel support** and an internal note is hidden from a customer viewer
5. Panel: open a room's **Simulate** page. Check the off screen (centred options, no bars), the top-nav pill, the Power confirmation, the volume overlay, and "Touch to begin" (set a timeout in the room's **Settings**). Then open it on a real 7" and 10" panel and note the size the browser reports (CSS pixel width), whether the glass blur is smooth (if not, add a lite mode), and touch target size
6. Room groups: create a group, add two rooms with designs, add a wall, press **Update combined rooms**. Working when: a combined room appears in **Rooms** and opens in the designer with both rooms' devices

Also (small, yours): set `STAFF_TICKET_WEBHOOK_URL` on Vercel if you want escalation notifications; delete merged branches on GitHub; keep `STAFF_REQUIRE_MFA` and `STAFF_HOST` unset in production.

---

### B. Quick actions from drivers

Why: the panel's bottom bar and Quick Actions sheet are built and tested, but nothing supplies actions, so it is always empty. Blank Screen and Privacy Mute are the two that matter.

Pre-read:
- `docs/panel-ui-requirements.md` ("Quick actions (supplied by drivers)")
- `docs/driver-sdk.md` ("Planned: quick actions")
- `packages/model/src/room/common.ts` and `catalog.ts` (capabilities per device category)
- `packages/model/src/runtime/panel.ts` (`PanelQuickAction`, the `quickaction.run` intent) and `packages/engine/src/runtime/runtime.ts` (`buildSnapshot`, `dispatch`; `quickaction.run` is accepted but ignored today)
- `packages/drivers/src/real/pjlink.ts` (PJLink `AVMT` blank command), `declarative.ts` and `packages/model/src/driver-spec.ts`
- `packages/panel-ui/src/BottomBar.tsx`

Do: add a `blank` capability and a `blanked` feedback field; add `quickActions` to the driver format (standard ids `display.blank`, `mics.privacy_mute`); teach PJLink to blank; make the engine offer Blank only when the room has a display whose driver supports it, and Privacy Mute only with conferencing microphones and a conference system; handle `quickaction.run` (one button acts on every device that supports it); show state from feedback; add simulator device support; tests.

Depends on: nothing. Done when: in the simulator a room with a PJLink display shows a working Blank Screen button, and a room without one shows none.

**Status: built** (branch `feat/quick-actions`). Differences from the plan above: no model `blank` capability (support is declared by the driver, per the decision); driver format is `quickActions: [ids]` plus standard commands `blank.on`/`blank.off`, not the label/icon object first sketched. Not done: a failed action is silent; blank is not cleared when the source changes; the browser simulator does not see an org's custom drivers. Details: `docs/driver-sdk.md` (Quick actions), `docs/panel-ui-requirements.md` (Slice 2).

### C. Room groups: gateway runtime

**Status: built** in four pull requests (protocol and settings, gateway runtime, Link rooms menu, group deploy and simulator). The decisions asked below were answered by the user and are recorded with the ones made while building in `docs/decisions.md`. Still to do: apply the `divider_actions` migration; try it on a real gateway. The text below is the original brief.

Why: the portal side is built (groups, walls, derived combined rooms). Nothing yet opens or closes a wall at runtime, so a combined room can be designed and deployed but never becomes live. This is the largest remaining piece.

Pre-read (all of it, before writing code):
- `docs/room-groups.md` (whole file, especially "Runtime")
- `docs/diagrams.md` section 23 and `docs/phase-4-preread.md` ("Known limitations")
- `packages/engine/src/groups/combinations.ts` (`enumerateCombinedRooms`, `liveCombinations`: already gives which combined rooms are live for a set of open walls)
- The current implementation you will replace: `apps/gateway/src/combine.ts`, `room-host.ts`, `gateway.ts`; `packages/engine/src/runtime/runtime.ts` (`setCombination`, `setSecondary`, `follow`); `packages/model/src/gateway/protocol.ts` (`CombinationConfig`, `CombinationReport`); `packages/panel-ui/src/PanelApp.tsx` (`following` branch, `CombineBar`)
- `apps/web/src/server/room-groups.ts` and `routers/room-group.ts` (what the cloud already knows)
- `apps/gateway/src/room-host.ts` (each room gets its own device bus) and `packages/drivers/src/real/hybrid-bus.ts` (how drivers connect per room; a physical device must never be driven by two runtimes at once)

Decide with the user before coding:
1. How a wall's state is set: panel button, portal, sensor, or all three (proposed: panel and portal now, sensor later)
2. Transition rules: opening (if any member room was on, does the combined room start on?) and closing (members go Off, or restore what they had?) (proposed: on opening start on if any member was on; on closing members go Off)
3. Whether members of one group can be deployed together as one action (proposed: yes, one "deploy group" that deploys members then combined rooms)

Sub-slices:
- **R1 protocol and config**: send each gateway its groups (rooms, walls, the combined rooms and their members) in the config, report open walls in the heartbeat; keep the old fields tolerated for gateways in the field
- **R2 gateway coordinator**: own the wall state (persist it, works offline), decide which combined rooms are live with `liveCombinations`, suspend member runtimes and start the combined runtime and back, with the transition rules
- **R3 control and panels**: a `divider.set` control (panel intent and portal control), member panels mirror the live combined room's UI, the portal control page shows walls
- **R4 group deployment and simulator**: deploy a group in one action; simulate walls opening and closing in the browser

Depends on: nothing. Done when, in the simulator with fake devices: opening a wall makes the combined room run and suspends its members; closing reverses it; the state survives a gateway restart with no internet.

### D. Remove the old combinations code and table

**Status: part 1 built** (every reader and writer, the panel intent and bar, the protocol fields, the model schema and the tests are gone; the `RoomCombination` model stays in `schema.prisma` with a comment). **Part 2 is yours, after the release to `main` is live:** add a migration dropping the table (`DROP TABLE "RoomCombination"`), remove the model from `schema.prisma`, and check `grep -ri roomcombination` finds only migration history. The protocol version stays 1 (decision D-1 in `docs/decisions.md`). The text below is the original brief.

Why: the first combined-rooms design was wrong and is being replaced (C). Its code and table are still there.

Pre-read: `docs/room-groups.md` ("Data model", "Slices"), `apps/web/src/server/combinations.ts` and `control-service.ts` (`queueCombine`), `gateway-service.ts`, `packages/model/src/room/behaviour.ts` (`RoomCombination`), `packages/db/prisma/schema.prisma` (`RoomCombination`).

Do, in two releases: (1) remove every reader and writer, the panel `combine.set` intent and bar, and the protocol fields (bump the protocol version, keep parsing old messages); deploy; (2) a follow-up migration dropping `RoomCombination`.

Depends on: C deployed everywhere. Done when: `grep -ri roomcombination` finds only the migration history.

### E. Audit retention and export

**Status: built.** Nothing left to decide; the migration `org_retention` (one new table) still has to be applied. Until it is, only the daily audit clean-up reports an error (the rest of the retention job still runs) and the staff retention panel shows an error. The text below is the original brief.

Decided in the staff plan review; not built.

Pre-read: `docs/staff-portal-and-msp.md` ("Decisions from review" item 3 and "Still open"), `apps/web/src/server/audit.ts`, `routers/audit.ts`, the `AuditLog` and `StaffAudit` models, `apps/web/src/app/api/cron/retention` and `apps/web/vercel.json` (the daily cron), `docs/plan.md` step 5.

Do: a per-organisation retention setting (12 months by default; billing and access-change events kept longer, staff can extend), purge in the daily retention job for both logs, CSV and JSON export of the activity log for owners and for staff (staff exports are themselves audited).

Decide: the default period and which events are kept longer. Done when: old rows are purged by the cron and an owner can download their log.

### F. Panel function pages

**Status: built** (cameras, microphones, room controls). Left for later: camera tracking and a recorder page (F-2). Try it on real devices: a VISCA camera, a Shelly relay screen, a lighting processor. The text below is the original brief.

Why: the panel shows Sources and Record only. The planned pages (cameras, microphones and audio, recorder, room controls) need model and engine data that does not exist yet.

Pre-read: `docs/panel-ui-requirements.md` ("Screens", "Build status"), `packages/model/src/runtime/panel.ts`, `packages/engine/src/runtime/runtime.ts` (`buildSnapshot`), `packages/model/src/room/room-model.ts` (`userControls`), `packages/drivers/src/real/visca.ts` and the `camera_preset`, `lighting` capabilities, `packages/panel-ui/src/PanelApp.tsx`.

Do: extend the panel view model with per-function data, engine intents for camera preset, pan/tilt/zoom and tracking, mic mute, lighting scenes; render the pages under the top nav only when the room has the capability. Done when: a training room with a PTZ camera and lights shows Cameras and Room Controls pages in the simulator.

### G. Org accent colour in the portal

**Status: built.** The text below is the original brief.

Why: decided that one accent colour themes the portal and the panel, with the same contrast check. Today only the panel uses it.

Pre-read: `packages/panel-ui/src/theme.ts` (`legibleAccent`), `apps/web/src/components/common/branding-fields.tsx`, `apps/web/src/server/panel-settings.ts` (`readOrgBranding`), `apps/web/src/app/globals.css` (colour tokens), `apps/web/src/components/shell/org-shell.tsx`.

Do: apply the org's accent to the portal's primary tokens for that organisation, using `legibleAccent` in both themes; warn in the branding form when the chosen colour had to be adjusted. Done when: changing the accent changes the portal and the panel and never produces unreadable text.

### H. Email notifications

**Status: built.** It only sends once `RESEND_API_KEY` and `ALERT_FROM_EMAIL` are set (needs the sending domain, step 6), and staff get escalation emails when `STAFF_TICKET_EMAIL` is set. The text below is the original brief.

Blocked on a domain and a verified Resend sender (step 6 above).

Pre-read: `apps/web/src/server/ticket-notify.ts` (Teams and webhook today), `alerts.ts` (email channel already exists for incidents), `docs/staff-portal-and-msp.md` (tickets).

Do: send ticket events (escalation, staff reply, status change, hand back) by email to the right people, with the same rules as Teams and webhook, and let staff and providers opt in. Done when: an escalation emails the configured staff address.

### I. Staff user management and a staff audit viewer

**Status: built.** The text below is the original brief.

Why: staff are added only by `apps/web/scripts/add-staff.mts`, and `StaffAudit` has no viewer.

Pre-read: `apps/web/src/server/staff.ts`, `scripts/add-staff.mts`, the `StaffUser` and `StaffAudit` models.

Do: a `/staff/team` page (admin only) to add, change and remove staff by email, and a `/staff/audit` page to browse the trail with filters by staff member, organisation and action. Done when: an admin can add a support person without the script.

### J. Assign tickets to provider people

**Status: built.** The text below is the original brief.

Pre-read: `apps/web/src/server/routers/ticket.ts` (the `update` procedure requires the assignee to be an organisation member), `apps/web/src/server/msp.ts` (`mspAccess`), the `Ticket.assignedTo` column.

Do: allow an assignee who reaches the organisation through an active provider connection (needs an assignee reference that is not only a `Member`), show them by name and provider, and keep it working after a connection ends (assignee cleared). Done when: a provider can assign a customer's ticket to one of its own people.

### K. SLAs and priority timers

**Status: built** with fixed calendar-time targets and no stored data; per-organisation targets, business hours and notifications are not. The text below is the original brief.

After the first customers. Pre-read: `docs/staff-portal-and-msp.md`, `apps/web/src/server/tickets.ts`. Do: response and resolution targets per priority, a "due" column in the staff and provider queues, and a warning as a ticket nears its target.

### L. Provider billing and white label

**Decided 2026-09-27: the customer always pays Kestrel directly; no wholesale billing. White label (look only) is built, see AA.** The text below is the original brief. Needs a business decision first: today the customer pays Kestrel directly and the provider pays nothing. Pre-read: `docs/staff-portal-and-msp.md` ("Decided": billing), `apps/web/src/server/stripe.ts`, `billing.ts`, `packages/model/src/billing.ts`. Options to decide: the provider pays for its customers' rooms (wholesale), per-customer choice, or provider-branded panels and portal.

### M. Earlier candidates

WSS push (removes the first-connect lag), Stripe Connect payouts for marketplace publishers, third-party driver marketplace, sandboxed custom-logic hooks. Pre-read for each: `docs/phase-4-preread.md` ("Known limitations", "Suggested next steps"), `docs/driver-sdk.md`, `docs/plan.md` (Key Architectural Bets).

### Launch readiness (added 2026-09-26, do soon, none done)

From the MVP-to-launch review. Legal items need a lawyer; the rest are build or setup work. A code scan on 2026-09-26 found no Terms or Privacy pages, no rate limiting, no CSP or security headers, no customer MFA (staff only) and no backup or incident docs; re-check before starting.

**Before any paying customer**

- [ ] **LR-1 Terms of Service / SaaS agreement.** Liability cap (including a bad deploy taking rooms down), acceptable use, IP ownership of customer room programs.
- [ ] **LR-2 Privacy Policy.** Australian Privacy Act 1988 / APPs; GDPR too if any EU or UK customers or users. State the real data location (Vercel compute may not be in AU).
- [ ] **LR-3 Data Processing Addendum (DPA) template.** Kestrel acts as processor. Enterprise customers will ask.
- [ ] **LR-4 Subprocessor list.** Supabase, Vercel, Stripe, Resend, GitHub/GHCR, plus any email or Teams providers. Publish it.
- [ ] **LR-5 Acceptance flow.** Click-through at sign-up and org creation; store the terms version and timestamp per user or org. Terms and Privacy pages in the portal.
- [ ] **LR-6 SLA position.** Decide what is promised, or state nothing is promised at launch.
- [ ] **LR-7 Stripe live and tax.** Move from test to live; GST/tax settings, invoices, refund and cancellation terms.
- [ ] **LR-8 Company basics.** Registered entity, professional indemnity and cyber insurance, owned domain and sending domain (SPF/DKIM/DMARC; already blocks email in step 6).
- [ ] **LR-9 Rate limiting and lockout.** Login, password reset, gateway enrollment, panel PIN attempts, tRPC API.
- [ ] **LR-10 Security headers.** CSP, HSTS, frame-ancestors; CSRF review of the Stripe and cron endpoints.
- [ ] **LR-11 Prod and dev separation.** Separate Supabase and Stripe projects; rotate secrets used during development.
- [ ] **LR-12 Backups.** Supabase point-in-time recovery (paid tier) and a tested restore.
- [ ] **LR-13 Breach runbook.** Australian Notifiable Data Breaches scheme: who decides, who notifies the OAIC and affected people, and within what time.
- [ ] **LR-14 Personal data map.** What is held (emails, names, IPs, audit logs, ticket contents, calendar data), why, and for how long. Feeds LR-2 and LR-3.

**Before the first enterprise deal**

- [ ] **LR-15 Customer MFA.** Available to all; enforced for owner and dev roles.
- [ ] **LR-16 Org deletion and full data export.** Deletion that cascades, plus user and org export (audit export exists; the rest does not).
- [ ] **LR-17 Retention policy.** Extend beyond the 90-day telemetry and audit settings: tickets, deleted accounts, backups.
- [ ] **LR-18 Row Level Security as defence-in-depth,** plus cross-tenant access tests on every router.
- [ ] **LR-19 Signing key plan.** Storage, rotation and compromise recovery for the manifest signing key.
- [ ] **LR-20 Gateway hardening.** Enrollment token revocation, image signing (cosign) with a pinned digest, updater that cannot be hijacked.
- [ ] **LR-21 Supply chain.** Dependabot, `pnpm audit` in CI, lockfile review.
- [ ] **LR-22 Error tracking and alerting.** Sentry (or similar) with PII scrubbing; alerts on failed cron jobs and webhooks.
- [ ] **LR-23 Third-party penetration test,** `security.txt` and a disclosure contact.
- [ ] **LR-24 Operations.** Vercel Pro (cron limits and commercial-use terms), status page, staged gateway rollout with a tested rollback, support intake and onboarding doc.
- [ ] **LR-25 Load and soak test.** ~50 rooms per gateway; many gateways sending heartbeat and telemetry together.
- [ ] **LR-26 SOC 2 or ISO 27001 groundwork.** Start collecting evidence early (Vanta or Drata). Essential Eight / IRAP only if targeting Australian government.

### Post-launch roadmap (added 2026-09-26; built and merged to `dev` 2026-09-27, PRs #59-#74)

Candidates from the MVP-to-launch review. Only usage and occupancy analytics was kept from the "big value adds"; predictive health, AI room design, the marketplace and simulator sharing were dropped (the marketplace stays under M as before). Each item below says what was built, in which PR, and what was left out. **Nothing here has had a browser pass or a real-hardware test.**

**After merging: migrations and deploy order**

- Six new migrations, none applied by the build: `20260927100000_report_schedule` (W), `20260927110000_api_keys` (X), `20260927120000_commissioning_runs` (Y), `20260927130000_room_schedule` (U), `20260927140000_provider_brand` (AA), `20260927150000_device_firmware` (T). Apply with `pnpm --filter @kestrel/db exec prisma migrate deploy`. Each only affects the feature that uses it
- Deploy the web app before updating gateways: #63 (analytics) adds a telemetry event type, #69 (discovery) a command type, and #72 (bookings) and #74 (firmware) heartbeat fields that an older side would refuse or ignore. Discovery, bookings and firmware are also gated on features a gateway reports (`discovery`, `schedule`, `firmware`)
- Staging rooms are left out of usage analytics and monthly reports (done after the merge)

**N. Usage and occupancy analytics. Built: #63.** A Usage page (monitoring feature): hours in use, share of business hours per room, sessions, hours by day, a day-and-hour heatmap in the viewer's time zone, activity mix, and plain-language insights. Gateways now report a room-level `room.occupancy` event. Not built: no-shows (needs U); business hours are fixed at Mon to Fri 8am to 6pm; reach is the 90-day telemetry retention.

**Missing features**

- **O. Bulk operations and staged rollouts. Built: #60** (with R). Choose rooms on the Deployments page, then deploy or roll back together, with a "send to one room first" canary. The canary is not gated automatically: a person opens the dialog again to send the rest (automatic gating needs a rollout table). No scheduling of a bulk deploy.
- **P. Room cloning and site templates. Built: #61.** Duplicate room on the room settings page. Stamping many rooms from a master was already possible with Save as template plus the bulk sheet.
- **Q. Config diff and history. Built: #62.** Each release opens to show what it changed, comparable with any other release, with who published it; "Restore this design" puts an old release's design back in the working draft (the current draft is saved first). The diff engine already existed.
- **R. Pre-deploy validation and dry run. Built: #60** (with O). The bulk dialog previews every room and names any that cannot go, with the reason. Also #70: deploying now publishes a new release when a driver has a newer version.
- **S. Device discovery. Built: #69.** "Find devices on the network" on the Devices page: the gateway looks at its own private /24 networks for well-known control ports and asks PJLink devices who they are; "Use this address" fills a device's address. Read-only. Not built: identifying non-PJLink devices beyond the port, other VLANs, other ports.
- **T. Firmware and driver update management. Driver half built: #70. Firmware reporting built (read only): #74, see `docs/device-firmware.md`.** Devices report the firmware version they run (PJLink class 2, Biamp Tesira, and any custom driver with a `firmware` pattern); it shows on the room's monitoring page and on a new **Firmware** page (by driver, with a "Mixed versions" flag). Needs migration `20260927150000_device_firmware`. **Not built:** updating firmware (Kestrel never changes a device), alerts on old versions, a known-good version list, a version history, and firmware reporting for the other bundled drivers (each needs its vendor's documented query).
- **U. Room booking display. Built (read only): #72.** The panel shows the room's calendar: the meeting on now (title, organiser, start, end) and "Next available at", or "Available" and "Next meeting at". Private meetings show as "Private meeting". Uses the room's calendar trigger and needs migration `20260927130000_room_schedule`. `docs/room-booking.md`. Not built: booking from the panel and releasing no-shows (needs calendar write access), a per-room off switch, a day view.
- **V. Notification and escalation rules. Built: #65.** Per alert channel: only alert on chosen days and hours (overnight and time zones work), wait before alerting (skipped if acknowledged), repeat until acknowledged. An on-call rota is a channel per person. No migration (rules live in the channel config).
- **W. Reporting. Built: #64.** A Reports page (a month's use, reliability, support; print or save as PDF), "Email me a copy", and an optional monthly email to a list. Text email only.
- **X. Public API and outbound webhooks. Built: #67.** API keys (Settings) and read-only `GET /api/v1/rooms`, `/rooms/{id}`, `/incidents` (`docs/public-api.md`). Outbound events already exist as the Webhook alert channel. Not built: control from the API, usage and report data, events other than problems.
- **Y. Mobile tech app and commissioning checklist. Built: #68.** A Commissioning tab per room: a checklist made from the design, Works/Problem/Skip on each item (made for a phone), sign-off, a record that never changes, printable. Not built: photos on failed items, and driving the room from the check screen.
- **Z. Staging rooms. Built: #66.** A staging copy of a room (free, no alerts, badged) and Promote to a live room (into its draft, with the live draft saved first).
- **AA. White label for service providers. Built (name, logo, colour): #73.** A provider sets its brand on its home page; a customer's owner chooses per connection to show it in their portal and, as a fallback, on their panels. **The customer always pays Kestrel directly** (decided 2026-09-27; the wholesale option in L is dropped). Needs migration `20260927140000_provider_brand`. `docs/white-label.md`. Not built: custom domains, branded sign-in and emails.
- **AB. SSO (SAML/OIDC). Sign-in side built: #71.** "Sign in with single sign-on" on the login page and `docs/sso.md` for the per-company Supabase setup. **Not run end to end** (needs a real identity provider and a paid Supabase project). Not built: forcing SSO-only for a company, SCIM, and role mapping from provider groups.

### Small fixes to fit in anywhere

- One gateway test (`apps/gateway/src/panel-server.test.ts`, "greet the panel and stream the room state") failed once in a full run and passed twice on rerun: make it deterministic
- `KESTREL_ADMIN_EMAILS` is gone from code; make sure it is deleted from Vercel
- The old `docs/staff-portal-plan` branch on GitHub can be deleted
