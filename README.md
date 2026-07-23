# Schedule Manager

> ⚠️ **This project is under active development.** Features change, break, and
> get rebuilt without notice, and there's no guarantee of stability between
> commits. Expect rough edges if you deploy your own instance today.

A personal scheduling app: a week calendar with tasks, projects, and time budgets, an
AI assistant for quick edits ("push my gym block to 6pm"), and a Planner — a
longer-horizon AI chat for talking through projects and keeping notes tied to
your schedule. Built with Next.js, Supabase (Postgres + Auth), and deployed on
Vercel.

This repo is self-serve: everything you need to run your own independent
instance is below. No account or access from the original author is required.

## Features

- Week calendar with tasks, recurring commitments, and per-day working-hours limits
- External calendar sync (ICS feeds) merged onto your schedule
- Web push notifications (end-of-day check-ins, weekly summaries)
- An AI assistant for fast, single-message schedule edits
- A **Planner**: a separate chat for discussing ongoing projects, building
  execution plans, and keeping notes — see "The Planner" below

## What you'll need

**Important:** there is no single sign-on here. This app runs across three
separate companies' infrastructure (Supabase for the database, Vercel for
hosting, Anthropic for the AI), plus GitHub to get the code — so you need
**four separate free-to-start accounts**, not one. Nothing auto-creates the
others for you.

| Account | What it's for | Signup time | Cost |
|---|---|---|---|
| [GitHub](https://github.com) | Hosts the code you'll deploy from | ~2 min (skip if you have one) | Free |
| [Supabase](https://supabase.com) | Your database (tasks, schedule, notes) + login system | ~2 min signup, ~2 min for the project to spin up | Free tier is enough for personal use |
| [Vercel](https://vercel.com) | Hosts the actual running app at a URL | ~2 min, plus linking GitHub | Free (Hobby plan) |
| [Anthropic](https://console.anthropic.com) | Powers the AI assistant/planner | ~3 min, requires a payment method | Pay-per-use, no flat fee — typically **$1–15/month** for personal use depending on which model you pick (see Settings → Assistant model in the app for a breakdown) |

Total hands-on setup time is roughly **20–30 minutes**, most of which is
waiting for accounts/projects to provision rather than active work.

## One-time setup

Everything in this section is done **once**, when you first deploy. After
that, using the app day-to-day is just opening the URL — none of this repeats.

### 1. Clone and install

```bash
git clone https://github.com/mbarcodia/schedule-manager.git
cd schedule-manager/web
npm install
```

### 2. Create a Supabase project

Go to [supabase.com/dashboard](https://supabase.com/dashboard) → New project.
Once it's created, open **Project Settings → Data API** and **Project
Settings → API Keys** — you'll need the project URL, the publishable key, and
the secret (service role) key in the next step.

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → Data API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Project Settings → API Keys → publishable key |
| `SUPABASE_SECRET_KEY` | Project Settings → API Keys → secret key (server-only, never exposed to the browser) |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys (see "Getting an Anthropic API key" below) |
| `OWNER_EMAIL` | The email you'll sign up to your own deployment with. `ANTHROPIC_API_KEY` above is only ever used for requests from this account — anyone else who signs up must add their own key in Settings, with no fallback |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Run `npx web-push generate-vapid-keys`; optional — only needed for push notifications |
| `VAPID_SUBJECT` | `mailto:you@example.com` — required alongside the VAPID keys |
| `CRON_SECRET` | Any random string, e.g. `openssl rand -hex 32`. Authenticates the cron/notification routes |

### 4. Apply the database schema

The schema lives as plain SQL migration files in `supabase/migrations/`,
applied with the Supabase CLI — no manual copy-pasting into a SQL editor.

Get your database connection string from **Project Settings → Database →
Connection string → URI** (use the "Direct connection" one, not the pooled
one, and make sure to swap in your actual database password), then run:

```bash
supabase db push --db-url "postgresql://postgres:[YOUR-PASSWORD]@[YOUR-HOST]:5432/postgres"
```

This applies all migrations in order against your new, empty database — it
creates every table (tasks, projects, notes, planner state, etc.), Row Level
Security policies, and grants. It's safe to re-run; already-applied
migrations are skipped.

### 5. Run locally (optional, to try it before deploying)

```bash
npm run dev
```

Open `http://localhost:3000`, sign up (Supabase Auth — email/password by
default), and you should land on an empty calendar.

### 6. Deploy to Vercel

- Import the repo at [vercel.com/new](https://vercel.com/new).
- Set the project **Root Directory** to `web`.
- Add all the same environment variables from `.env.local` in the Vercel
  project's Settings → Environment Variables.
- Deploy.

The included `vercel.json` sets up one daily cron (`sync-calendars`) — that's
the maximum Vercel's free Hobby plan allows (2 jobs/once-daily). For
finer-grained notification timing, see the optional GitHub Actions step below.

### 7. Optional: hourly notification digests via GitHub Actions

Vercel's Hobby plan can't run cron more than once a day, so the end-of-day
check-in and weekly summary routes (which need to fire at each user's chosen
local hour) are instead triggered by `.github/workflows/digest-notifications.yml`,
which runs hourly on GitHub Actions and is free on a public repo.

To enable it on your own fork/repo, add these as **Repository secrets**
(Settings → Secrets and variables → Actions):

- `PROD_BASE_URL` — your deployed app's URL (e.g. `https://your-app.vercel.app`)
- `CRON_SECRET` — the same value you set in Vercel

If you don't set these up, the app still works — you just won't get the
hourly-precision digest notifications (daily calendar sync still runs via
Vercel's cron).

## What you do every time you use it

Nothing from the setup above. Once deployed, using the app is just:

- Open your Vercel URL and log in (or stay logged in — sessions persist).
- Use the calendar, assistant, and planner normally.

The only "maintenance" you'd ever touch again is redeploying if you pull code
updates from upstream, or checking your Anthropic billing occasionally — both
optional, neither required to keep using the app.

## Getting an Anthropic API key

The assistant and planner call the Anthropic API. To get your own key:

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign in
   or create an account. (This is separate from a claude.ai subscription —
   it's billed per-token usage, not a flat monthly fee.)
2. Add a payment method under **Billing**.
3. Go to **API Keys** and create a new key.
4. Put it in `ANTHROPIC_API_KEY` in your `.env.local`/Vercel env vars.

**Important:** `ANTHROPIC_API_KEY` is only ever used for requests from the
account whose email matches `OWNER_EMAIL` — that's you, the person deploying
this. If anyone else signs up on your deployment, they must add their own key
under **Settings → Planner AI**; there is no fallback to your key for them.
This is deliberate — usage should never bill to your Anthropic account on
someone else's behalf.

## The Planner

The Planner (`/planner` in the app) is a separate, longer-horizon chat from
the quick-edit assistant — for discussing ongoing projects, building
execution plans, and keeping notes tied to your schedule, with state that
persists across sessions.

- It has everything the quick assistant has (create/edit tasks and events,
  log progress), plus notes.
- Each note has a kind (idea, todo, paper, update, other) and can be linked
  to a project/proposal/goal/task, or left unlinked.
- Create and edit notes either by asking the planner in chat ("add a note to
  ACE2 about the new element we need to design") or directly in the sidebar.
- The sidebar groups notes under their linked project; **Export notes** in
  the sidebar header downloads everything as one Markdown file.
- The planner reads your existing notes when relevant, so you don't need to
  re-explain context every session.
- Pick which Claude model the planner uses, and optionally add your own
  Anthropic API key, under **Settings → Planner AI**.

## License

Built by Marybeth C. Arcodia with Claude (Anthropic) — 2026.

MIT — see [LICENSE](LICENSE). Use, modify, and redistribute freely, including
commercially, as long as the copyright notice stays attached.
