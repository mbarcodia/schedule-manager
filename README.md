# Schedule Manager

> ⚠️ **This project is under active development.** Features change, break, and
> get rebuilt without notice, and there's no guarantee of stability between
> commits. Expect rough edges if you deploy your own instance today.

A personal scheduling app: a week calendar with your projects, tasks, and time
budgets; one AI chat beside it that handles both quick edits ("push my gym block
to 6pm") and guided planning for a whole semester; and a planner board that
reads the live schedule and tells you what's keeping up and what isn't. Built
with Next.js, Supabase (Postgres + Auth), and deployed on Vercel.

This repo is self-serve: everything you need to run your own independent
instance is below. No account or access from the original author is required.

## Overview

These words do all the work. The app, the chat, and these docs use them the same
way, so you can say what you mean and be understood.

| Word | What it is |
| --- | --- |
| **Project** | Anything you're currently working on — a research project, a proposal, a literature review, a manuscript. One kind of thing with optional parts, mixed freely: weekly hours the scheduler defends, a hard deadline, a cadence. |
| **Target** | A date inside a project that takes no time of its own ("first round of analysis done by the end of August"). Shows as a marker on the timeline; click it when you hit it. If getting there needs hours, that's a task, added separately. |
| **Task** | A one-off piece of work whose hours get scheduled onto the calendar, placed by priority and deadline. Usually belongs to a project. This is the only one of these that consumes time. |
| **Routine** | A standing weekly slot: email, lunch, gym, lab meeting. Repeats on its own. |
| **Time block** | What any of the above looks like once it's on the calendar. It wears its label's name in the corner; a routine says "Routine". |
| **To-do** | Something to do, on a list you name. Occupies no time by itself; can gain a date, reminders and booked hours whenever you decide it needs them. |
| **Label** | A grouping you name yourself — Deep focus, Teaching, Admin. Add as many as you like. It colours the left edge of its time block and names it, and carries three scheduling settings: a minimum chunk length, which half of the day that kind of work belongs in (a preference, or a hard rule), and optionally a share of each week it should get. |

A project's weekly hours can be given an **active window** — a course that
only needs five hours a week from December, a project that pauses over a
conference. Without one, the hours are booked from today onward, which is right
for something already running and wrong for anything that starts later.

A project is in one of three states. **Active** schedules normally. **On hold**
keeps it visible and remembers its weekly rate but schedules nothing — for work
that is genuinely paused rather than abandoned; it warns only when its date gets
tight. **Archived** takes it off the boards, keeping its hours and dates.

**Removing is not destroying.** Notes, to-dos, lists, targets and events go to a
**Trash** tab you can restore them from; tasks and projects are **archived**, which
is different and deliberate — archived means *finished*, and its logged hours still
count toward what you got done. Nothing in either expires or is cleaned up on a
schedule. Emptying the Trash is the only action in the app that destroys anything,
and the chat cannot do it.

A **reminder** isn't a separate thing: it's a to-do with a date and one or more
lead times. The **Lists** tab is separate again — that's for things you're
keeping track of (a reading list, what to pack) rather than things you'll do, and
nothing on it is ever scheduled or notified.

## What it does

Everything below is built and working — this is the whole feature set, not a roadmap.

**Calendar and scheduling engine**
- Week view of work, routines, and meetings, with per-day working hours
- You describe a task (hours needed, deadline, pacing, chunk size) and the engine places it; change anything and the whole week re-solves around it
- A deadline can be a **date** ("due August 11" — any time that day counts) or an
  exact moment ("2pm on the 10th"). A bare date stays a bare date: no hour is
  invented for it, so reminders and placement don't key off a time you never set
- External calendars merged in read-only via ICS feed (Outlook, Google, iCloud) — nothing is ever written back to them
- Check blocks off, log partial progress, or pin a block to an exact time; missed time reschedules itself later in the week
- Forgot to tick something? It stays put, greyed and still tickable, for a grace
  period you set (default 4 hours, Settings → Un-ticked blocks) and you get a
  notification before that runs out. Ticking a block early or late asks whether
  you did it in its original slot or just now, so the hours land in the right
  place
- Projects can carry a weekly-hours target the scheduler defends, claiming
  mornings by priority — or afternoons, or only between two dates
- Targets: dated checkpoints inside a project that consume no hours, so an
  interim date doesn't have to be faked as a task with an invented duration.
  Each can carry the hours due by it, so a checkpoint two weeks out is measured
  against its own slice rather than the whole project
- A task can be held to **one day** or **one unbroken block**, and carry its own
  minimum chunk. Both are hard rules: if no gap is big enough it stays off the
  calendar and says so rather than being split anyway
- Routines can hold a set time, a window, the **start or end of the day**
  (moving with your hours, with nothing scheduled past them), or anywhere that
  day
- A label can claim a **share of each week** — measured against the whole week,
  or against what's left after meetings. The weekly hours on the projects
  wearing it then act as a ratio between them rather than a total you keep in
  sync by hand
- **What the week keeps back**: tell it how much of a typical week goes to
  meetings and miscellany, and "can I take this on?" is answered against the
  hours you really have. Advisory — the scheduler still fills the week, but pace
  stops recommending a rate no week could hold
- Anything unscheduled says **why** in one line — restricted to a half-day with
  no room, its hours not started yet, no free time left this week — and a benign
  reason is greyed rather than flagged, so a correctly-configured project doesn't
  look broken
- Sliding view: show 1, 3, 5 or 7 days at a time and shift the window a day at
  a time, so a "week" can start on any weekday; past weeks stay readable as a
  record

**Chat (beside the calendar)** — two explicit modes, chosen with a toggle so it's never ambiguous which you're in:
- **Chat** — a question or one change, answered straight away: "how free is Thursday?", "push my gym block to 6pm", "add 3h of grading due Friday, max 1h/day". Routine one-liners are routed to a smaller model.
- **Planning session** — a guided interview for a semester, a month, or a new project: it asks a few questions at a time and fills your planner boards as you answer, working outward from fixed projects to flexible work, and saves standing scheduling rules it learns. Always uses your chosen model.
- Reads your real capacity either way, and pushes back when a stretch is overcommitted
- Keeps durable notes per project (kinds: idea, todo, paper, update, other), exportable as one Markdown file
- Runs on your own Anthropic API key **or** your existing Claude Pro/Max subscription

**Planner board** (eight views: the first four read the live schedule and can't drift from it, the next three are yours to write in, and the last two are what you have finished and what you have removed). Each opens with a short "what am I looking at", collapsible and remembered.
- **Week** — three numbers per label, because they fail differently: TARGET (from its share of the week), BOOKED (what the scheduler placed), DONE (what you ticked). Target vs booked is a capacity problem; booked vs done is a follow-through problem. A travel week has less capacity, so its target shrinks with it
- **Progress** — projects in columns read from reality, not a status you maintain: whether the work left fits the time left at the current weekly rate. Judging that needs an effort estimate and a date, so a project without them sits in **Needs setup** and names the missing figure rather than guessing. Tasks appear under their project; drag one to pin it to today, move it up the queue, or unpin it
- **Priorities** — importance (you set it, on projects and tasks alike) against urgency (read from the nearest date). The two trap quadrants are the point
- **Timeline** — six months of project dates with their targets marked along the way. A date is either **hard** (externally imposed) or a **goal** you set yourself — scheduled toward the same way, but only a goal is yours to move when it slips
- **To-Do** — an item starts as a plain line; open it to say what it is: just a line, due by a date, or happening at a set time. Either can gain reminders and booked hours whenever you decide it needs them — set an earlier finish-by to book preparation (those blocks are labelled "Prep:"). A list can notify you about whatever is still unticked when the week, month or year ends
- **Lists** — reading lists, packing lists, standing agendas: a paragraph, a checklist, or both, with nothing scheduled or notified
- **Archive** — finished work is archived, never deleted, so logged hours survive for "what did I get done this semester?"; Restore puts something back
- **Trash** — everything you have *removed*, and the way back. Notes, to-dos, lists, targets and events all land here instead of being destroyed, grouped by the action that removed them: a list that took fourteen items with it is one entry that restores all fifteen rows. Nothing expires or is swept on a timer
- A live weekly-review strip (done/total, work-in-progress limit, missed blocks, at-risk deadlines) and a guided "Time to plan" interview

**Everything is settable two ways.** Anything you can say to the chat you can
also type into a panel, and vice versa: projects (hours, dates, targets, effort
estimate, importance, active window, on hold, archive), tasks, events, routines,
a single day's hours, and labels. The chat is never the only route to a field.

**Public booking page** (Calendly-style, optional)
- Share a link; visitors see a column per day with the available times listed under each, computed from your working hours, calendars, and protected labels
- Per-link rules, all in **Settings → Booking page** (each link summarises its own underneath it): meeting lengths, bookable days with an earliest/latest time per day, minimum notice before someone can book, a buffer around meetings, and a maximum number of bookings per day. These are intentionally UI-only rather than chat-editable — they control what strangers can do to your calendar.
- Visitors choose video or in person when you offer both; bookings land on your calendar (and optionally your real Google Calendar, which emails them an invite)
- Either side can cancel or reschedule from a private link

**Nothing gets silently dropped**
- Every destructive action says what it will take with it, counted: "14 items, 3
  with booked hours on the calendar" rather than "and everything on it"
- The chat can archive and trash but **cannot destroy anything**. It resolves what
  you name by fuzzy match, which is right for "log 45 minutes on grading" and
  wrong for a permanent delete, so the permanent path was removed rather than
  guarded
- A write that fails says so on screen instead of quietly reloading the old value
- `npm run migrate` takes a full local snapshot **before** applying any
  migration, and refuses to migrate if the snapshot fails — a schema change is
  the other way data goes missing, and Trash cannot help there
- `npm run check` fails the build if any code path hard-deletes one of those
  tables, reads one without filtering out trashed rows, or adds a destructive
  migration without saying what happens to the data

**Notifications**
- Web push: end-of-day check-in and weekly review, at your chosen local hour
- Reminders on dated to-dos, at lead times you set per item
- A warning before an un-ticked block's grace period runs out
- End-of-week / month / year nudges for whatever a list still has unticked

**Deliberately efficient AI use** — prompt caching, small-model routing for routine edits, and a no-filler output rule; see ["Running this efficiently"](#running-this-efficiently)

## What you'll need

**Important:** there is no single sign-on here. This app runs across three
separate companies' infrastructure (Supabase for the database, Vercel for
hosting, Anthropic for the AI), plus GitHub to get the code — so you need
**four separate free-to-start accounts**, not one. Nothing auto-creates the
others for you.

| Account | What it's for | Signup time |
|---|---|---|
| [GitHub](https://github.com) | Hosts the code you deploy from | ~2 min (skip if you have one) |
| [Supabase](https://supabase.com) | Your database (schedule, notes, projects) + login | ~2 min, plus ~2 min for the project to spin up |
| [Vercel](https://vercel.com) | Hosts the running app at a URL | ~2 min, plus linking GitHub |
| AI access — see ["Connecting Claude"](#connecting-claude-two-options) | Powers the chat and planner | varies by option |
| [Google Cloud](https://console.cloud.google.com) *(optional — booking page)* | Puts booked meetings on your real Google Calendar and emails the guest an invite | ~15 min |
| [Fly.io](https://fly.io) *(optional — AI Option B)* | Hosts the small relay for running the AI on a Claude subscription | ~3 min, needs a payment method |

Costs for all of these are in one place below.

Total hands-on setup time is roughly **20–30 minutes** for the core app, most
of which is waiting for accounts/projects to provision rather than active
work. The two optional extras add about **15 minutes each**: the booking
page's Google connection, and the relay if you want to run the AI on a Claude
subscription instead of an API key.

### What it costs to run

| | Monthly cost | Notes |
|---|---|---|
| Supabase, Vercel, GitHub | **$0** | Free tiers are comfortably enough for one person's schedule |
| Fly.io relay *(only if using a Claude subscription)* | **under $1** | Scales to zero: pennies of storage while idle, per-second compute only during a planner turn |
| Google Cloud *(only if using the booking page)* | **$0** | Calendar API is free at this volume |
| **Option A — your own Anthropic API key** | typically **$3–15** | Depends entirely on how much you chat; see below |
| **Option B — existing Claude Pro/Max subscription** | **$0 extra** | Uses quota you already pay for, shared with your normal Claude usage |

Model rates on Option A (per million tokens, **as of August 2026** — check
[Anthropic's pricing page](https://platform.claude.com/docs/en/pricing) for
current numbers):

| Model | Input | Output | Good for |
|---|---|---|---|
| Claude Haiku 4.5 | $1 | $5 | Routine one-liners — used automatically, not selectable |
| Claude Sonnet 5 | $3 | $15 | Cheaper; reliable on planning and multi-step tool use |
| Claude Opus 4.8 | $5 | $25 | Recommended default; long-horizon planning and realism checks |
| Claude Fable 5 | $10 | $50 | Most capable. API key only — not on subscription plans |

A typical day of quick edits plus one real planning conversation lands in the
low tens of cents. Three things in this app hold that down without degrading
answers: the unchanging half of the prompt is cached rather than reprocessed,
routine one-line commands are routed to a smaller model, and the AI is
instructed not to generate filler.

## One-time setup

Everything in this section is done **once**, when you first deploy. After
that, using the app day-to-day is just opening the URL — none of this repeats.

### 1. Clone and install

```bash
git clone https://github.com/mbarcodia/schedule-manager.git
cd schedule-manager
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
| `APP_ORIGIN` | Your app's base URL — `http://localhost:3000` locally, your Vercel URL in production. Used for booking links and OAuth redirects |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional — only for the booking page's Google Calendar connection. See ["Enabling Google Calendar"](#enabling-google-calendar-for-your-deployment) |
| `PLANNER_RELAY_URL`, `PLANNER_RELAY_SECRET` | Optional — only if you run the AI on a Claude subscription (Option B) |
| `ALERT_SECRET`, `ALERT_OWNER_USER_ID` | Optional — used by the cron-drift alert described in `CRON_SECRET_RUNBOOK.md` |

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

If that command sits there printing nothing, your network is probably blocking
port 5432 — see "If `npm run migrate` stops and says the port is blocked" below,
which is the same problem and has the way around it. After this first setup, use
`npm run migrate` rather than the CLI directly: it takes a backup first and picks
a route that works.

This applies all migrations in order against your new, empty database — it
creates every table (schedule, projects, notes, planner state, etc.), Row Level
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
- Leave **Root Directory** at the repository root (the Next.js app lives there;
  Vercel detects it automatically).
- Add all the same environment variables from `.env.local` in the Vercel
  project's Settings → Environment Variables.
- **Change `APP_ORIGIN`** to your deployed URL (e.g.
  `https://your-app.vercel.app`) — not `http://localhost:3000`. Booking links
  and OAuth redirects are built from it, so a stale value silently sends guests
  to localhost.
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

## First run: getting set up inside the app

The steps above get the app running; these get *you* running. All of it lives
in **Settings**, which has a jump-list down the left side.

1. **Sign up** at your deployed URL (email + password). You land on an empty
   calendar.
2. **Claude access** — paste an Anthropic API key, or a Claude Pro/Max
   subscription token. Nothing AI-related works until this is set, and it's
   per-account: your credential is never shared with or billed to anyone else
   who uses your deployment.
3. **Standard hours** — the working window for each weekday, plus how much of a
   typical week to keep back for meetings and miscellany. Everything the
   scheduler does is bounded by this, so it's worth getting roughly right
   before adding tasks.
4. **Routines** — standing weekly slots, at a set time, in a window, at the
   start or end of the day, or wherever they fit.
5. **Labels** — groupings you name yourself, for whatever your work actually is
   (Deep focus, Teaching, Admin…). A label colours the left edge of its time
   block and names it, and sets how that kind of work is scheduled: a minimum
   chunk length, which half of the day it belongs in, and optionally a share of
   each week. The booking page can also protect specific labels from being
   booked over.
6. **Connected calendars** — paste the ICS feed URL from Outlook / Google /
   iCloud so existing meetings block time. Read-only: nothing is written back.
7. **Notifications** *(optional)* — turn on push and pick the end-of-day and
   weekly-review hours.
8. **Booking page** *(optional)* — add your name, a video-meeting URL and/or an
   in-person location, then create a link. See ["Booking page"](#booking-page).

Also there: **Standing rules** (free-text instructions the planner carries into
every conversation), **Un-ticked blocks** (the grace period), and **Calendar
view** (how many days at a time).

Then just talk to the chat beside the calendar: *"I have a standing meeting
Tuesdays at 10"*, *"add 6 hours a week of analysis, due mid-March"*, *"3h
grading due Friday, no more than 1h a day"*. It creates the projects, tasks, and
routines for you — you don't have to fill anything in by hand.

After this, day-to-day use is just opening the app and logging in; sessions
persist. Nothing in the setup above repeats, and there's no maintenance beyond
redeploying if you pull code updates.

## Install it as a Mac app (optional, ~30 seconds)

The app ships as an installable web app, so you can run it in its own window
with a Dock icon — no separate download, no extra build, nothing to maintain.

**In Chrome on macOS:**

1. Open your deployed URL in Chrome and sign in.
2. Reload once with **⌘⇧R** (Chrome caches web manifests).
3. **⋮ menu → Cast, Save and Share → Install Schedule** → confirm **Install**.
4. Right-click the new Dock icon → **Options → Keep in Dock**.

You get a standalone window with no tabs or address bar, ⌘-Tab switching, and
right-click Dock shortcuts straight to the planner board and settings. Safari
17+ offers the same thing via **File → Add to Dock**.

Two things worth knowing:

- **Updates are automatic.** The window points at your deployment, so a
  `git push` that Vercel deploys reaches it on next open — there's no bundle to
  rebuild or reinstall. Only a change to the app's name, icon, or manifest
  identity would need reinstalling. If a *notification* change seems missing,
  quit with **⌘Q** and reopen so the service worker updates.
- **Everything server-side keeps working while it's closed** — calendar sync,
  digest notifications, and your booking page all run on a schedule
  independently of your Mac.

You won't see an install icon in Chrome's address bar: Chrome only shows that
automatic prompt for apps with an offline-capable service worker, and this app's
data is entirely server-side, so it deliberately doesn't pretend to work
offline. Installing from the menu is unaffected.

## Connecting Claude: two options

Every user adds their own Claude credential from inside the app after signing
up — there's no env var for it, and no way for one account's usage to reach
another's bill (see ["Isolation model"](#isolation-model-who-pays-for-what)).
The two options coexist; pick per person and switch anytime in Settings. Costs
are in ["What it costs to run"](#what-it-costs-to-run).

| | **Option A: Anthropic API key** | **Option B: Claude Pro/Max subscription** |
|---|---|---|
| Models | All, including Claude Fable 5 | Up to Claude Opus 4.8 (subscription plans don't include Fable 5) |
| Extra infrastructure | None | A tiny relay server you deploy once on your own Fly.io account (see below) |
| Requires | An [Anthropic Console](https://console.anthropic.com) account with a payment method | A paid claude.ai plan (Pro or higher — the free plan doesn't qualify) + [Claude Code](https://claude.com/claude-code) installed once to mint the token |
| Usage limits | Whatever you're willing to spend | Shares your plan's usage pool (5-hour window + weekly cap) with everything else you do on your Claude account |

### Option A: Anthropic API key

At [console.anthropic.com](https://console.anthropic.com) — a separate,
per-token-billed account from a claude.ai subscription — add a payment method
under **Billing**, create a key under **API Keys**, then paste it into your
app's **Settings → Claude access**. That one key covers everything.

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
- Subscription tokens cap out at Claude Opus 4.8 — the Fable 5 model option
  needs an API key. You can switch between the two at any time in Settings.

> **Before deploying the relay:** open `fly.toml` and change the `app` name.
> Fly app names are globally unique, so the name in this repo is already taken
> and `fly deploy` will fail until you pick your own (e.g.
> `yourname-planner-relay`).

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

There is one AI chat, and it sits beside your calendar — it handles both quick
edits and long-horizon planning. The **Planner** link (`/planner`) opens the
board views described above, plus your notes sidebar. Settings → "How the
planner works" explains each view and how it maps onto the real schedule.

- The chat can do everything: create/edit tasks and events, log progress, pin
  research time, archive finished tasks, and keep notes.
- Each note has a kind (idea, todo, paper, update, other) and can be linked
  to a project or a task, or left unlinked.
- Create and edit notes either by asking in chat ("add a note to the review
  project about the section we still need to draft") or directly in the sidebar.
- The sidebar groups notes under their linked project; **Export notes** in
  the sidebar header downloads everything as one Markdown file.
- It reads your existing notes when relevant, so you don't need to re-explain
  context every session.
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
Allow**). That's expected for a self-hosted tool; verification is only required
past 100 users. The only scope requested is
calendar events — the app can create and update the meetings it books, and
nothing else.

## Keeping up to date

**Your copy does not update itself.** A clone is a snapshot: you get the code as
it was the day you cloned it, and later changes upstream never reach you
automatically. That isolation is deliberate — it's the same reason nobody else
can see your calendar or spend your API credit — but it does mean pulling
changes is a thing you choose to do.

To pull newer code, once:

```bash
git remote add upstream https://github.com/mbarcodia/schedule-manager.git
```

then whenever you want the latest:

```bash
git pull upstream main
```

Pushing that to your own repo triggers your Vercel deploy as usual. On GitHub's
website the equivalent is the **Sync fork** button on your fork's main page.

### After pulling, two things may be needed

**1. Run any new migrations — with `npm run migrate`.** This is the one that
bites. If the update added a database column, your database doesn't have it yet,
and the new code will fail on every request that touches it.

```bash
npm run migrate
```

That is `npm run backup && supabase db push`, in that order and deliberately
chained: a migration is the one moment the app can lose data with nobody
watching, and the push does not run if the snapshot fails. The snapshot lands in
`backups/` as timestamped JSON (git-ignored — it is the plaintext of everything
you have written).

Already-applied migrations are skipped, so it's safe to run every time — and
running it *before* the new code goes live avoids the gap entirely.

If the CLI isn't linked to your project yet, run `supabase link` once, or pass
the connection string explicitly (Project Settings → Database → Connection
string → **Direct connection**, with your database password — which is the
Postgres password from when you created the project, not your app login):

```bash
supabase db push --db-url "postgresql://postgres:[YOUR-PASSWORD]@[YOUR-HOST]:5432/postgres"
```

Calling the CLI directly like that goes around `npm run migrate`, so it takes no
backup and does not check whether this network can reach port 5432 — on one that
cannot, it hangs with no output instead of failing. Prefer `npm run migrate` and
let it pick the route.

#### If `npm run migrate` stops and says the port is blocked

Some networks — university, corporate, a fair few hotels — block outbound
Postgres. `supabase db push` speaks the Postgres wire protocol on port 5432, so
on one of those it has nothing to connect on, and because such networks *drop*
the packets rather than refusing them there is no error either: left alone, the
push waits indefinitely with no output at all. `npm run migrate` checks for this
before starting and takes a few seconds to say so, naming what it tried.

Usually it then goes ahead anyway. If `SUPABASE_ACCESS_TOKEN` is set (see step
4), `npm run migrate` applies the pending migrations over HTTPS instead, through
Supabase's Management API — same token, same SQL, port 443, which these networks
do allow. Each one is recorded in the migration history as it is applied, so the
CLI knows it is done and will not replay it:

```
This network drops outbound Postgres connections, so `supabase db push`
cannot connect — it would hang with no output rather than fail.
Going over HTTPS instead, which this network allows.
  applied and recorded  0049_example.sql
```

Set `MIGRATE_NO_HTTPS=1` if you would rather it did not.

Two kinds of statement cannot take that route, because Postgres will not run
them inside a transaction: `create index concurrently` and `vacuum` are the ones
you are likely to meet. Those are refused by name rather than half-applied, and
want either the dashboard's **SQL Editor** or a network that allows port 5432.
A migration applied by hand leaves no history row and will be replayed later,
which is harmless here because migrations are written to survive a second run
(`add column if not exists`) — worth a glance if you have written your own.

**2. Redeploy the relay, if you use one.** Only relevant if you connected Claude
through a Pro/Max subscription (see "Connecting Claude" above). The relay bundles its own copy
of the app's data layer, so a schema change breaks it until it's rebuilt — while
your Vercel deployment looks perfectly healthy and the chat fails with a generic
error:

```bash
flyctl deploy --now
```

`npm run deploy` does the push and the relay deploy together, which is the safer
habit. The hourly notification workflow also calls the relay's `/health`
endpoint, so a relay left behind after a migration surfaces as a workflow
failure rather than silently breaking every chat turn.

### What pulling never touches

Your data. Projects, tasks, calendars, notes and settings live in **your**
Supabase project, which upstream code has no access to. Updating the code changes
the app, never its contents.

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
