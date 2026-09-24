# Phase 4 Pre-read (cold start) — supersedes phase-1-preread

> Read this + `CLAUDE.md` + `docs/plan.md`. Product = **Kestrel** (repo folder `cobra`). No Avrus/avisor branding anywhere. Progress is NOT tracked in plan.md — this file is the status source.

## Working agreements

- Terse dot-point replies; save tokens. Confirm before starting a big chunk of code if the user hasn't said go
- Git flow: `feat/*`/`fix/*` from `dev` → PR to `dev` → **user merges** → PR `dev` → `main` (user merges). Never commit to `main`/`dev` directly. Trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- Never push/PR/merge unasked. Never commit `.env*`. Multiple sessions have worked in this repo — always check `git log`, branches, `gh pr list` before assuming state

## Status (as of 2026-09-24)

| Phase | State |
|---|---|
| 0 Foundations | Done, deployed (Vercel `main`, Supabase `kestrel-dev` Sydney) |
| 1 Room modelling | Done, merged (PR #6) |
| Web app shell (extra) | Done, merged (PR #7): shadcn, IBM Plex, `/o/[orgId]/…` routes, invites, team, audit log |
| 2 Engine/simulator/panel UI | Done, merged (PR #8) |
| 3 Gateway | Built; **PR #9 open, not merged** (`feat/phase-3-gateway`) |
| 4 Releases & deployments | Built on **`feat/phase-4-deployments`** (stacked on phase 3; not pushed, no PR). Commits: `de05fcf` TCP reachability on start, `6d40c3b` engine design diff, `d4971b0` staged deploys/health check/rollback/scheduling/drift |
| 5 Monitoring, 6 Billing, 7 Expansion | Not started |

- Phase 4 verified by a temporary e2e (`apps/web/scripts/e2e-deploy.mts`, header says "Not committed"): 11/11 PASS — clean deploy timeline (downloading > verifying > staging > health_check > active), bad release rolled back ("could not reach DSP") with gateway staying on release 1, room state `failed`, scheduled deploy starts on time, in_sync after. It starts a cloud on :3200 + a real gateway against the **dev database** and deletes its temp org. Decide: commit as a proper script/test, or delete
- Uncommitted working tree on the Phase 4 branch: `CLAUDE.md` (status pointer), `docs/phase-1-preread.md` (stale, delete), this file, `apps/web/scripts/`

## Repo map (added since Phase 0)

- `apps/web` — portal (+ browser simulator); routers: audit, deployment, draft, gateway, invite, member, org, release, room, site, template; server modules `deployment-service`, `deployment-queries`, `gateway-service`
- `apps/gateway` — Node gateway service, `Dockerfile`, README (GHCR image, stable/beta channels)
- `apps/panel` — Vite panel SPA served by gateways (PIN gate, reconnecting WebSocket)
- `packages/model` (room schemas, device catalog, templates, protocol schemas) · `engine` (validator, RoomRuntime, activity planner, executor, design diff) · `drivers` (`sim/` simulated devices, `real/` PJLink + generic TCP + hybrid real/simulated bus + registry) · `crypto` (Ed25519 signed manifests, tokens, PIN hashing) · `panel-ui` (generated panel) · `db` · `config`
- Migrations: init, room_drafts_templates, members_email_invites, gateway_releases_events, deployments

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

## MVP gaps

- MVP real hardware not yet written: **Crestron DM-NVX** virtual matrix (1× DM-NVX-E30 encoder, 1× DM-NVX-D30 decoder) and **Q-SYS Core** DSP (gain component script name `gain`). Existing real drivers: PJLink, generic TCP only
- "Gateway runs a room against real devices, panel on LAN offline" not yet verified on hardware
- Phase 5 thin slice for MVP = live status only

## Suggested next steps (in order)

1. **Merge PR #9** (Phase 3, user merges) → push `feat/phase-4-deployments` and open its PR to `dev` (diff should shrink to Phase 4 commits once #9 is merged; rebase if needed) → `dev`→`main` PR
2. Decide fate of `apps/web/scripts/e2e-deploy.mts` (promote to committed script/CI-safe test, or delete); commit/delete stale `docs/phase-1-preread.md`; refresh `CLAUDE.md` status + repo layout ("scaffold — not yet created" is stale)
3. Write DM-NVX and Q-SYS drivers (`packages/drivers/src/real/`, register in `registry.ts`) + tests; run a real-hardware test with the Docker gateway
4. Start **Phase 5**: telemetry ingest, room/device health, events/incidents, live status (Supabase Realtime), alerts (email/Teams/webhook/ITSM stub), allowlisted remote commands + audit, 90-day retention
5. Then Phase 6 billing (Stripe per-room tiers), Phase 7 expansion (triggers, combined rooms, marketplace, gateway self-update, Windows installer)
