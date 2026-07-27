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
- A **Planner**: a board (kanban, Eisenhower, months-long timeline, archive)
  plus a chat for discussing projects, building execution plans, and keeping
  notes — see "The Planner" below
- A **public booking page** (Calendly-style): share a link, visitors book from
  your real availability, meetings land on your calendar — see "Booking page"
- Deliberately token-frugal AI usage — see ["Running this efficiently"](#running-this-efficiently)

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
| AI access — see ["Connecting Claude"](#connecting-claude-two-options) | Powers the AI assistant/planner | varies | **Option A:** Anthropic API key, pay-per-use (~$1–15/month typical). **Option B:** your existing Claude Pro/Max subscription + a tiny relay server (~$0.15–1/month on Fly.io) |
| [Fly.io](https://fly.io) *(optional — Option B only)* | Hosts the small relay that lets the Planner run on your Claude subscription | ~3 min, requires a payment method | Scale-to-zero: **well under $1/month** (pennies of storage while idle, per-second compute only during planner turns) |

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
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Run `npx web-push generate-vapid-keys`; optional — only needed for push notifications |
| `VAPID_SUBJECT` | `mailto:you@example.com` — required alongside the VAPID keys |
| `CRON_SECRET` | Any random string, e.g. `openssl rand -hex 32`. Authenticates the cron/notification routes |

There's no Anthropic key here — every user (including you) adds their own
from inside the app after signing up. See "Getting an Anthropic API key"
below.

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

## Connecting Claude: two options

The assistant and planner need a Claude credential. There's no env var for
this — every user, including you, adds their own from inside the app, once,
after signing up. **Nothing is ever shared or billed across accounts**: no
shared key, no fallback, and no way for one user's AI usage to land on
another user's (or the deployer's) bill.

You have two options. They can coexist — pick per person, and switch anytime
in Settings.

| | **Option A: Anthropic API key** | **Option B: Claude Pro/Max subscription** |
|---|---|---|
| Billing | Pay-per-token to Anthropic (typically $1–15/month personal use) | Covered by the flat subscription you may already pay for ([claude.ai](https://claude.ai) Pro/Max) |
| Works with | Quick assistant **and** Planner | **Planner only** (the quick assistant still needs an API key) |
| Models | All, including Claude Fable 5 | Up to Claude Opus 4.8 (subscription plans don't include Fable 5) |
| Extra infrastructure | None | A tiny relay server you deploy once on your own Fly.io account (see below) |
| Requires | An [Anthropic Console](https://console.anthropic.com) account with a payment method | A paid claude.ai plan (Pro or higher — the free plan doesn't qualify) + [Claude Code](https://claude.com/claude-code) installed once to mint the token |
| Usage limits | Whatever you're willing to spend | Shares your plan's usage pool (5-hour window + weekly cap) with everything else you do on your Claude account |

### Option A: Anthropic API key

1. Sign up and log in to your deployed app.
2. Go to **Settings** → **Anthropic API key**.
3. Go to [console.anthropic.com](https://console.anthropic.com) and sign in
   or create an account. (This is separate from a claude.ai subscription —
   it's billed per-token usage, not a flat monthly fee.)
4. Add a payment method under **Billing**, then go to **API Keys** and
   create a new key.
5. Paste it into Settings.

One key covers both the assistant and the planner.

### Option B: your Claude Pro/Max subscription (via a self-hosted relay)

Your subscription can power the Planner instead of a metered API key. Two
parts: mint a personal token, and run a small relay server (the token only
authenticates through the Claude Agent SDK, whose bundled binary is too
large for Vercel functions — hence the separate tiny server).

**Honest caveats first:**

- `claude setup-token` is Anthropic's documented mechanism for personal
  automation under a subscription. Routing it through your own self-hosted
  app is a reasonable personal use, but it's your account — Anthropic could
  change policy, and heavy automated use draws from the same usage pool as
  your own claude.ai and Claude Code sessions.
- The token is planner-only; keep (or add) an API key if you also want the
  quick assistant.

**B1. Mint your token** (on your own computer, once):

```bash
npm install -g @anthropic-ai/claude-code   # if you don't have Claude Code
claude setup-token
```

Log in with your claude.ai account when prompted; copy the token it prints
(`sk-ant-oat01-…`).

**B2. Deploy the relay to your own Fly.io account** (once per deployment —
the deployer does this, not each user):

1. Sign up at [fly.io](https://fly.io) and install
   [flyctl](https://fly.io/docs/flyctl/install/).
2. In `web/fly.toml`, change the `app` name to something globally unique
   (e.g. `yourname-planner-relay`).
3. From the `web/` directory:

   ```bash
   fly launch --no-deploy          # registers the app; accept the existing fly.toml
   fly secrets set \
     PLANNER_RELAY_SECRET="$(openssl rand -hex 32)" \
     NEXT_PUBLIC_SUPABASE_URL="<your Supabase project URL>" \
     SUPABASE_SECRET_KEY="<your Supabase secret key>"
   fly deploy
   ```

4. In your **Vercel** project's environment variables, add:
   - `PLANNER_RELAY_URL` — `https://<your-app-name>.fly.dev`
   - `PLANNER_RELAY_SECRET` — the same value you set on Fly
5. Redeploy on Vercel.

The relay scales to zero: it sleeps between planner turns (pennies/month of
storage) and wakes in ~1–2 seconds when a turn comes in. It is only
callable by your Vercel deployment (authenticated by `PLANNER_RELAY_SECRET`)
and only serves your instance.

**B3. Paste your token in the app:** Settings → planner credential →
subscription token. Each user of your deployment who wants subscription
billing repeats B1 + B3 with their own claude.ai account; B2 is shared
infrastructure you host.

### Isolation model (who pays for what)

This repo is a **self-host template**: each person (or household) deploys
their own fully independent instance — own Supabase, own Vercel, own
optional Fly relay, own Claude credentials. Nothing about your instance
touches the original author's accounts, and vice versa. Within one
deployment, every signed-up user brings their own Claude credential; the
deployer's only shared costs are the hosting itself (free tiers + the
optional sub-$1 relay).

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
- Pick which Claude model the planner uses under **Settings → Planner AI**.
  The planner runs on whichever credential you set up — an Anthropic API key
  or your Claude Pro/Max subscription (see "Connecting Claude" above).

## Booking page

A public link (like Calendly) anyone can use to book time with you. Availability
is computed from your working hours, your connected calendars, your recurring
blocks, and — optionally — task categories you mark as protected. Booked
meetings appear on your calendar immediately, which also blocks the slot for the
next visitor and reflows flexible task time around the meeting.

Each account sets this up for itself in **Settings → Booking page**, which shows
a checklist of what's still missing:

1. **Your name** — invitations are titled "Guest name &lt;&gt; your name".
2. **A meeting location** — a video-room URL (e.g. your personal Zoom room)
   and/or an in-person location. Links can offer either or both; when both are
   offered the visitor chooses, and video guests are told the link will be
   emailed rather than having it shown on a public page.
3. **Google Calendar (optional)** — connect it and each booking is also created
   on your real Google Calendar with the visitor invited, so Google sends them
   a normal calendar invitation. Without it, bookings still appear in this app
   and you still get a push notification; the visitor gets an on-screen
   confirmation plus a downloadable `.ics` invite.
4. **A booking link** — set the meeting lengths on offer, which days/times are
   bookable, buffers, minimum notice, and a per-day cap. Copy its URL and share
   it.

Either side can cancel or reschedule: every booking has a private management
link (in the confirmation and the calendar invite), and your own bookings are
listed in Settings with the same controls.

### Enabling Google Calendar for your deployment

Google integration needs one OAuth client, created once per deployment (not per
user), on a Google account you control:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. Enable the **Google Calendar API**.
3. **OAuth consent screen**: External; add the scopes
   `.../auth/calendar.events`, `.../auth/userinfo.email`, and `openid`; then
   **Publish app**. Publishing matters — in "Testing" mode Google expires
   refresh tokens after 7 days and the connection silently breaks weekly.
4. **Credentials** → OAuth client ID → Web application, with redirect URIs
   `https://<your-app>/api/google/callback` and
   `http://localhost:3000/api/google/callback`.
5. Put the client ID and secret in Vercel as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, and set `APP_ORIGIN` to your deployed URL.

Because the app stays unverified by Google, each person connecting sees a
one-time "Google hasn't verified this app" warning (**Advanced → Go to… →
Allow**). That's expected for a self-hosted tool used by its own author;
verification is only required past 100 users. The only scope requested is
calendar events — the app can create and update the meetings it books, and
nothing else.

## Running this efficiently

AI inference costs energy, and most of that cost is invisible at the point of
use. This app is built to ask for as few tokens as it can while still giving
complete answers — the goal is no wasted computation, not shorter or worse
replies. Concretely:

- **Prompt caching.** The planner's persona and its whole tool schema are
  identical on every turn, so they sit before an explicit cache breakpoint and
  are re-read rather than reprocessed. Only the part that genuinely changed
  (clock time, your schedule snapshot, notes index) is processed fresh.
- **Right-sized model per turn.** A mechanical one-liner ("log 45 minutes on
  grading") is routed to a smaller model; anything that asks a question, weighs
  a trade-off, or spans multiple clauses stays on the model you chose. The
  router is deliberately conservative — it only steps down on requests it can
  recognise as a single edit, because a wrong downgrade costs answer quality
  while a missed one only costs tokens.
- **No filler generated.** The planner is instructed to skip preamble,
  restating your question, sign-offs, and recaps of what a tool already
  confirmed. Every token generated should carry information.
- **Nothing polled.** Calendar sync and digests run on a schedule rather than
  continuously, and the booking relay scales to zero when idle.

Further ideas, not yet built, if you want to push this further: batch the
non-urgent digest/summary jobs through the Batch API (half the tokens' cost and
scheduled off-peak); shrink the per-turn schedule snapshot to only the fields a
turn actually needs; cache the planner's tool schema across users; and prefer
the smallest model that passes your own evaluation for each surface rather than
defaulting to the largest. If you extend this app, the general principle worth
keeping: send only what changed, generate only what informs.

## License

Built by Marybeth C. Arcodia with Claude (Anthropic) — 2026.

MIT — see [LICENSE](LICENSE). Use, modify, and redistribute freely, including
commercially, as long as the copyright notice stays attached.
