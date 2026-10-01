# Getting the pivot (M0 to M7) to main

Status 2026-09-30: everything is committed on nine local branches stacked on `origin/main`
(`0b56bf5`). **Nothing is pushed.** GitHub Actions usage is exhausted, so every PR fails its checks
until the limit resets. All checks were run locally instead (web vitest, model, drivers, gateway,
`tsc`, `eslint`).

## Before opening anything

1. **Wait for Actions to be free**, then push one branch at a time. Each push and each PR runs CI.
2. **Fast-forward `dev` to `main`.** `dev` is 46 commits behind `main` and has nothing of its own
   (`git push origin origin/main:refs/heads/dev`). The project flow is feature branch to `dev` to `main`.
3. **Merge `fix/gateway-docker-node26` (PR #119) first.** It is small, separate and already open. Rebase
   the stack on `main` after it lands (it touches only `apps/gateway/Dockerfile`, so it will not conflict).
4. **Database.** Seven additive migrations are already applied to `kestrel-dev` (the only database in
   use). Before the web app that needs them is deployed to any other database, run
   `prisma migrate deploy` there. None drops or renames anything, so it is safe to run before the code.
5. **Secrets the gateway build needs:** `GATEWAY_RELEASE_SIGNING_KEY` (and `GATEWAY_CLOUD_URL_DEFAULT`
   variable). Without the key the Windows workflow refuses to publish, by design.

## The stack (bottom to top)

| # | Branch | What it adds | Migration | Size |
|---|---|---|---|---|
| 1 | `feat/pivot-m0` | Plan, decisions PV-1..22, diagrams, navigation skeleton | none | small |
| 2 | `feat/pivot-m1` | Devices (active and passive), areas, per-device gateway, signed device set, gateway polling | `pivot_devices` | medium |
| 3 | `feat/pivot-m2` | Asset register, device page, swap detection, overview KPIs | none | medium |
| 4 | `feat/pivot-m3` | Usage analytics ("in use" rules), site default gateway | `usage_analytics` | medium |
| 5 | `feat/pivot-m4` | Configuration: profiles, drift, snapshots, enforce, staged deploys | `configuration`, `configuration_tables` | medium |
| 6 | `feat/pivot-m5` | Support: maintenance windows, ticket rules, ITSM connectors | `support_and_maintenance` | medium |
| 7 | `feat/pivot-m5b` | Signed register issues, CSV import, preventative maintenance | `register_schedule_pm_due` | large |
| 8 | `feat/pivot-m6` | Service providers: portfolio, grants, provider library | `provider_portfolio` | medium |
| 9 | `feat/pivot-m7` | Tiers and billing, Monitoring board, removal of v1 control code, gateway 0.4.0, Windows hardening, Q-SYS fix | none | very large (mostly deletions) |

## How to open them with the fewest CI runs

Each PR runs the whole pipeline again, so stacking nine PRs costs nine runs plus a re-run every time a
base changes. Recommended, in order of preference:

- **Option A (recommended): four PRs.**
  - **PR-A** = `feat/pivot-m1` (includes m0): foundations. Base `dev`.
  - **PR-B** = `feat/pivot-m4` (m2, m3, m4): register, usage, configuration. Base `dev`.
  - **PR-C** = `feat/pivot-m6` (m5, m5b, m6): support, maintenance, providers. Base `dev`.
  - **PR-D** = `feat/pivot-m7`: tiers, removal, gateway. Base `dev`.
  - Merge with **merge commits** (not squash) so each milestone stays readable. Open PR-B only after PR-A
    merges, and so on, so each one only carries its own diff. Then one `dev` to `main` PR.
- **Option B: one PR.** `feat/pivot-m7` to `dev` in a single go (26k lines added, 23k removed). One CI run,
  but too big to review well. Only if the limit stays tight.
- **Option C: nine stacked PRs**, one per branch, each based on the one below. Best history, most CI.

Order to merge is always bottom to top. After a merge, retarget the next PR to `dev` (GitHub does this
automatically when the base branch is deleted) and let CI run again.

## Then release

1. `dev` to `main` as one PR (merge commit). Vercel deploys the web app from `main`.
2. **Gateway build.** The push to `main` runs `gateway-windows.yml` and `gateway-image.yml`: bundle
   (now compiled with esbuild), sign, installer, release `gateway-stable`. `dev` publishes `gateway-beta`.
   Confirm `GATEWAY_VERSION` is `0.4.0` (it is) so gateways see a new version.
3. **Do not order an update for the live estates until they are checked.** Gateways in the database
   (South Melbourne, Box Hill, Avrus Office) still run v1 rooms. 0.4.0 does not run rooms, so updating
   them stops their room control and monitoring by rooms. Either leave them on their version, or migrate
   their room devices first (`apps/web/scripts/migrate-legacy-devices.mts --apply`, dry run first).
4. Only after every gateway is on 0.4.0 or later: remove the v1 web endpoints (`manifest`, `bundle`, `poll`,
   `config`, `bindings`, `rooms`) and drop the v1 tables in a follow-up (M7-6). That migration is not
   written yet.

## Still to do before or alongside the PRs

- PM photos and revisiting a signed inspection (designs agreed in chat, not built).
- Browser pass of the actions in M3 to M7 (pages load; buttons not exercised).
- Security review of the new public endpoints (`/api/verify`, `/api/itsm/*`, `/api/itsm/*/mail`).
- Update `docs/plan.md` and `docs/diagrams.md` for M7 (`CLAUDE.md` and `decisions.md` are current).
- Check other drivers for the Q-SYS mistake (a device that answers with an error is shown offline).

## Safety net

- Tag `control-platform-v1` (local, on `origin/main`): the last state with the control platform intact.
  Push it with the first PR (`git push origin control-platform-v1`) so the removal can always be undone.
- Nothing here changes the database in a destructive way.
