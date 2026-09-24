# Kestrel — Getting Started (Supabase + Vercel)

## 0. Prereqs

- Node 22+ (`.nvmrc`), pnpm (`npm i -g pnpm`), Git, GitHub repo pushed
- Accounts: Supabase, Vercel (both linked to your GitHub)
- Run `pnpm install` at repo root

## 1. Supabase project

1. supabase.com → **New project**
   - Org: your own (keep separate from other brands)
   - Name: `kestrel-dev` (make a second `kestrel-prod` later)
   - Region: **Australia — Sydney (ap-southeast-2)**
   - Set a strong DB password → **save it**
2. Wait for provisioning (~2 min)

### Keys (Project Settings → API Keys / API)

- Project URL → `NEXT_PUBLIC_SUPABASE_URL`
- `anon` / publishable key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `service_role` / secret key → `SUPABASE_SERVICE_ROLE_KEY` (server only, never expose)

### DB connection strings (top bar **Connect** → ORMs / Connection string)

- `DATABASE_URL` = **Transaction pooler** (port 6543) — runtime, use on Vercel
- `DIRECT_URL` = **Session pooler** (port 5432 on the pooler host) — migrations
  - Prefer session pooler over "Direct connection": direct is IPv6-only and fails on many IPv4 networks (incl. some Windows/home setups)
- Replace `[YOUR-PASSWORD]` in both; URL-encode special characters in the password

### Auth (Authentication → Sign In / Providers, URL Configuration)

- Email provider: enabled
- Dev shortcut: turn **Confirm email** OFF for `kestrel-dev` so signup logs in immediately (keep ON in prod)
- **Site URL:** `http://localhost:3000` (dev) → change to prod domain later
- **Redirect URLs:** add `http://localhost:3000/**` and `https://*-<your-vercel-team>.vercel.app/**` (preview deploys) and your prod domain

## 2. Local env

1. `cp .env.example .env` (repo root) — fill the 5 values above
2. `apps/web` needs them too: copy to `apps/web/.env.local` (Next reads env from its own folder)
   - Prisma CLI loads the repo-root `.env` automatically (`packages/db/prisma.config.ts`)
3. Create tables: `pnpm --filter @kestrel/db migrate:dev --name init`
   - Creates `packages/db/prisma/migrations/` — commit these
4. `pnpm dev` → http://localhost:3000 → sign up → create org → site → room
5. Verify rows: Supabase → Table Editor (`Org`, `Site`, `Room`)

## 3. Vercel project

1. vercel.com → **Add New → Project** → import the GitHub repo
2. Settings on the import screen:
   - **Framework Preset:** Next.js
   - **Root Directory:** `apps/web`
   - Enable **"Include source files outside of the Root Directory"** (needed for monorepo packages)
   - Install/Build commands: leave default (Vercel detects pnpm + Turborepo; the `db` package's `build` runs `prisma generate` before the web build)
3. **Environment Variables** (add for Production + Preview + Development):
   - `DATABASE_URL` (runtime), `DIRECT_URL` (optional on Vercel; only migrations need it)
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - Tip: use a separate Supabase project for Production vs Preview/Dev
4. Deploy. Every PR gets a Preview URL; `main` = Production
5. Add Vercel URLs to Supabase → Auth → **Redirect URLs** (see above)

### Production branch

- Vercel → Settings → Git → Production Branch = `main`; `dev` and feature branches = previews

## 4. Migrations workflow

- Create/alter schema locally: `pnpm --filter @kestrel/db migrate:dev --name <change>`
- Commit migration files with the PR
- Apply to a hosted DB: `pnpm --filter @kestrel/db migrate:deploy` (run with that project's `DIRECT_URL`)
  - Do **not** run migrations inside the Vercel build; run manually or via CI on merge to `main` (CI step planned)

## 5. Git flow

- `main` = prod, `dev` = integration, `feat/*` = work; PRs only
- CI (`.github/workflows/ci.yml`) runs lint/typecheck/test on PRs

## 6. Checklist (tell me when done)

- [ ] Supabase `kestrel-dev` created (Sydney), keys + connection strings saved
- [ ] `.env` and `apps/web/.env.local` filled
- [ ] `migrate:dev --name init` ran; migration committed
- [ ] Local signup → org → site → room works
- [ ] Vercel project imported, root dir `apps/web`, env vars set, first deploy green
- [ ] Vercel preview URLs added to Supabase redirect URLs
- [ ] Branch `feat/phase-0-scaffold` committed → PR to `dev`

## Troubleshooting

- `Missing env var …` at runtime → env not in `apps/web/.env.local` / Vercel
- Prisma `P1001` can't reach DB → wrong host/port; use pooler strings; check password encoding
- `migrate:dev` can't connect to `placeholder@localhost` → `DIRECT_URL` not set in repo-root `.env`
- Signup works but no session → "Confirm email" is on; confirm via email or disable in dev
- Auth redirect error on preview → preview URL missing from Supabase Redirect URLs
