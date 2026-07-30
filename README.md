# Schedule Manager

> ⚠️ **This project is under active development.** Features change, break, and
> get rebuilt without notice, and there's no guarantee of stability between
> commits. Expect rough edges if you deploy your own instance today.

A personal scheduling app: a week calendar with your commitments, work, and time
budgets, an AI chat for quick edits ("push my gym block to 6pm"), and a Planner
— a longer-horizon AI chat for thinking a semester through and keeping notes
tied to your schedule. Built with Next.js, Supabase (Postgres + Auth), and deployed on
Vercel.

This repo is self-serve: everything you need to run your own independent
instance is below. No account or access from the original author is required.

## What things are called

These words do all the work. The app, the chat, and these docs use them the same
way, so you can say what you mean and be understood.

| Word | What it is |
| --- | --- |
| **Commitment** | Anything ongoing you've signed up for — a research project, a proposal, a course, a standing aim. One kind of thing with optional parts, mixed freely: weekly hours the scheduler defends, a hard deadline, a cadence. |
| **Target** | A date inside a commitment that takes no time of its own ("first round of analysis done by the end of August"). Shows as a marker on the timeline; click it when you hit it. |
| **Work** | Hours that get scheduled onto the calendar. Usually belongs to a commitment. This is the only one of these that consumes time. |
| **Routine** | A standing weekly slot: email, lunch, gym, lab meeting. Repeats on its own. |
| **Time block** | What any of the above looks like once it's on the calendar. |
| **To-do** | Something to do, on a list you name. Occupies no time by itself; can gain a date, reminders and booked hours whenever you decide it needs them. |
| **Label** | A colour-coded grouping you name yourself — Research, Writing, Teaching, Service. Work wears its label's colour on the left edge of its time block. |

A commitment's weekly hours can be given an **active window** — a course that
only needs five hours a week from December, a project that pauses over a
conference. Without one, the hours are booked from today onward, which is right
for something already running and wrong for anything that starts later.

A **reminder** isn't a separate thing: it's a to-do with a date and one or more
lead times. The **Lists** tab is separate again — that's for things you're
keeping track of (a reading list, what to pack) rather than things you'll do, and
nothing on it is ever scheduled or notified.

## What it does

Everything below is built and working — this is the whole feature set, not a roadmap.

**Calendar and scheduling engine**
- Week view of work, routines, and meetings, with per-day working hours
- You describe work (hours needed, deadline, pacing, chunk size) and the engine places it; change anything and the whole week re-solves around it
- External calendars merged in read-only via ICS feed (Outlook, Google, iCloud) — nothing is ever written back to them
- Check blocks off, log partial progress, or pin a block to an exact time; missed time reschedules itself later in the week
- Forgot to tick something? It stays put, greyed and still tickable, for a grace
  period you set (default 4 hours, Settings → Un-ticked work) and you get a
  notification before that runs out. Ticking a block early or late asks whether
  you did it in its original slot or just now, so the hours land in the right
  place
- Commitments can carry a weekly-hours target the scheduler defends, claiming
  mornings by priority — or afternoons, or only between two dates
- Targets: dated checkpoints inside a commitment that consume no hours, so an
  interim date doesn't have to be faked as work with an invented duration
- Sliding view: show 1, 3, 5 or 7 days at a time and shift the window a day at
  a time, so a "week" can start on any weekday

**Chat (beside the calendar)** — two explicit modes, chosen with a toggle so it's never ambiguous which you're in:
- **Quick task** — one change, executed immediately, no questions: "push my gym block to 6pm", "add 3h of grading due Friday, max 1h/day". Routine one-liners are routed to a smaller model.
- **Planning session** — a guided interview for a semester, a month, or a new commitment: it asks a few questions at a time and fills your planner boards as you answer, working outward from fixed commitments to flexible work, and saves standing scheduling rules it learns. Always uses your chosen model.
- Reads your real capacity either way, and pushes back when a stretch is overcommitted
- Keeps durable notes per commitment (kinds: idea, todo, paper, update, other), exportable as one Markdown file
- Runs on your own Anthropic API key **or** your existing Claude Pro/Max subscription

**Planner board** (four views over the same live schedule — nothing is a hand-maintained list)
- **Kanban** — Backlog / This Week / In Progress / Done, derived from what the schedule actually says; drag a card to change the schedule
- **Eisenhower** — importance (you set it) against urgency (read from deadlines)
- **Timeline** — six months of commitment deadlines with their targets marked along the way, coloured by whether booked hours can still cover them
- **To-Do** — lists you name, holding anything from a one-line errand to a talk you must prepare for; any item can gain a date, notification lead times, booked hours with both a start and a finish-by (which is how you book preparation \u2014 those blocks are labelled \u201cPrep:\u201d), and a fixed slot held on the calendar as an event, at any point after you write it down, and a list can notify you about whatever is still unticked when the week, month or year ends
- **Lists** — reading lists, packing lists, standing agendas: a paragraph, a checklist, or both, with nothing scheduled or notified
- **Archive** — finished work is archived, never deleted, so logged hours survive for "what did I get done this semester?"
- A live weekly-review strip (done/total, work-in-progress limit, missed blocks, at-risk deadlines) and a guided "Time to plan" interview

**Public booking page** (Calendly-style, optional)
- Share a link; visitors see only free slots computed from your working hours, calendars, and protected labels
- Per-link rules, all in **Settings → Booking page** (each link summarises its own underneath it): meeting lengths, bookable days with an earliest/latest time per day, minimum notice before someone can book, a buffer around meetings, and a maximum number of bookings per day. These are intentionally UI-only rather than chat-editable — they control what strangers can do to your calendar.
- Visitors choose video or in person when you offer both; bookings land on your calendar (and optionally your real Google Calendar, which emails them an invite)
- Either side can cancel or reschedule from a private link

**Notifications**
- Web push: end-of-day check-in and weekly review, at your chosen local hour

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
| [Supabase](https://supabase.com) | Your database (schedule, notes, commitments) + login | ~2 min, plus ~2 min for the project to spin up |
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

Model rates on Option A (per million tokens, **as of July 2026** — check
[Anthropic's pricing page](https://platform.claude.com/docs/en/pricing) for
current numbers):

| Model | Input | Output | Good for |
|---|---|---|---|
| Claude Haiku 4.5 | $1 | $5 | Simple task capture |
| Claude Sonnet 5 | $3 | $15 | Recommended default; strong on multi-step work |
| Claude Opus 4.8 | $5 | $25 | Deepest planning conversations |

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

This applies all migrations in order against your new, empty database — it
creates every table (schedule, commitments, notes, planner state, etc.), Row Level
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
3. **Standard hours** — the working window for each weekday. Everything the
   scheduler does is bounded by this, so it's worth getting roughly right
   before adding work.
4. **Labels** — colour-coded buckets, named for whatever your work actually is
   (Research, Writing, Teaching, Service…). Work carries its label's colour on
   the left edge of its time block, and the booking page can protect specific
   labels from being booked over.
5. **Connected calendars** — paste the ICS feed URL from Outlook / Google /
   iCloud so existing meetings block time. Read-only: nothing is written back.
6. **Notifications** *(optional)* — turn on push and pick the end-of-day and
   weekly-review hours.
7. **Booking page** *(optional)* — add your name, a video-meeting URL and/or an
   in-person location, then create a link. See ["Booking page"](#booking-page).

Then just talk to the chat beside the calendar: *"I teach Tuesdays and
Thursdays 9:30–10:45"*, *"add 6 hours of model analysis a week"*, *"3h grading
due Friday, no more than 1h a day"*. It creates the commitments, work, and
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
  research time, archive finished work, and keep notes.
- Each note has a kind (idea, todo, paper, update, other) and can be linked
  to a project/proposal/goal/task, or left unlinked.
- Create and edit notes either by asking in chat ("add a note to the model study about
  the new element we need to design") or directly in the sidebar.
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
