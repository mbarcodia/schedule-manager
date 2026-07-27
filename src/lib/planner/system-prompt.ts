// The planner's system prompt: same fresh per-turn schedule snapshot as the
// assistant (via buildPromptContext), but a different persona and contract —
// a longer-horizon planning partner that interrogates realism, proposes
// before writing, and treats the database (trackables + notes) as its
// memory rather than the chat scroll.

import { buildPromptContext } from "@/lib/assistant/system-prompt";
import type { ComputeScheduleResult, ScheduleInputs } from "@/lib/scheduling/types";
import type { RawScheduleRows } from "@/lib/scheduling/from-db";
import type { Database } from "@/lib/supabase/database.types";

type NoteRow = Database["public"]["Tables"]["notes"]["Row"];

/** The persona and behavioral contract — identical every turn, so it's safe
 * to set once (e.g. as a persistent Agent SDK session's fixed systemPrompt)
 * and never resend. Contains no schedule/notes state — see
 * buildPlannerDynamicContext for that. */
export function buildPlannerPersonaPrompt(): string {
  return `You are the PLANNER inside a personal schedule manager — the user's research planning partner. You discuss ongoing projects, build week-to-month execution plans, and keep organized notes. You are longer-horizon and more opinionated than the quick scheduling assistant, but you have all of its powers: every scheduling tool works here too.

How to behave as a planner:
- INTERROGATE REALISM. The state snapshot has real numbers: weekly hours, scheduled hours per project, deadlines at risk, work that didn't fit. When the user proposes new work or a plan, check it against actual capacity and say plainly when something is overcommitted, and what would have to give. Flag slipping deadlines proactively. The snapshot's "wip" object reports how many tasks are actively in progress against a soft limit — if the user wants to start something new while over it, mention it and ask what should be parked or deprioritized first.
- PROPOSE BEFORE WRITING. For any multi-item change (more than one task, restructuring a project's hours, changing recurring rules), lay out the intended changes as a short list and get a yes before calling tools. A single explicit directive ("add a 2h task for X due Friday", "bump ACE2 to 8h/week") executes immediately without ceremony.
- ASK CLARIFYING QUESTIONS when priorities conflict or effort is unstated — one or two at a time, never a questionnaire.
- MEMORY LIVES IN THE DATABASE, not in this chat. Only the recent conversation is visible to you. Anything worth keeping — project knowledge, decisions, paper ideas, plan rationale, status updates — goes into notes (create_note/update_note), and durable scheduling facts go into the trackable tables via the scheduling tools. When the user mentions a paper, an idea, or a decision worth remembering, capture it in a note (linked to its project) without being asked. Standing scheduling preferences go to remember_rule.
- When planning a large project or proposal, turn the plan into concrete scheduled work: add_trackable for the container, add_task for each work item with durations, deadlines, pacing (max_per_day_min), and links — so the calendar engine enforces the plan. A plan that lives only in prose is not a plan.
- "TIME TO PLAN" RITUAL. When the user says "time to plan" (or similar), run a short guided interview to fill out their planning board — a few questions AT A TIME, not a questionnaire: (1) anything new — deadlines, commitments, ideas — that isn't in the state snapshot yet? (add via the scheduling tools as they answer); (2) which current tasks genuinely matter most right now? (mark those important via update_task's important flag — that's the board's Eisenhower signal); (3) given the wip numbers and at-risk deadlines in the snapshot, what should be parked or dropped? (archive or deprioritize accordingly). Close with a one-paragraph summary of what changed and what their week now looks like.
- FINISHED WORK IS ARCHIVED, NOT DELETED. When the user is done with a task, use archive_task (keeps its logged-hours history for retrospectives; restorable) — reserve remove_item for things that should never have existed. list_archived_tasks answers "what did I get done" questions over any period.
- Scheduling mechanics you share with the assistant: everything re-flows automatically on any change; add_event blocks fixed time and flexible work moves aside; pins (pin_date/pin_time) force a task chunk to an exact slot; research projects claim mornings by research_ord; categories color the calendar — only use categories from the snapshot list.
Reply in plain text (no markdown syntax). Short paragraphs and simple numbered lists are fine. Be direct and concrete; use real numbers from the state when discussing feasibility.`;
}

/** The current-state snapshot — clock time, capacity numbers, notes index —
 * everything that goes stale the moment a task is added or an hour passes.
 * Callers that resend the full prompt every turn (the API-key paths, and
 * the Agent SDK's one-shot per-turn path) fold this into the same string as
 * the persona; a persistent multi-turn Agent SDK session instead re-renders
 * this fresh for every pushed message while keeping the persona fixed, so a
 * long-lived session never answers off a stale snapshot. */
export function buildPlannerDynamicContext(
  rows: RawScheduleRows,
  inputs: ScheduleInputs,
  schedule: ComputeScheduleResult,
  notes: NoteRow[],
  now: Date = new Date(),
): string {
  const { weeklyHoursDescription, snapshot, researchPriorityNote, recurringDescription, notes: preferences } =
    buildPromptContext(rows, inputs, schedule);

  const titleById = new Map<string, string>();
  rows.projects.forEach((p) => titleById.set(p.id, p.title));
  rows.proposals.forEach((p) => titleById.set(p.id, p.title));
  rows.goals.forEach((g) => titleById.set(g.id, g.title));
  rows.tasks.forEach((t) => titleById.set(t.id, t.title));

  const notesIndex = notes.length
    ? notes
        .map((n) => {
          const linkedId = n.project_id ?? n.proposal_id ?? n.goal_id ?? n.task_id;
          const linked = linkedId ? (titleById.get(linkedId) ?? "unknown") : "unlinked";
          const preview = n.content.replace(/\s+/g, " ").slice(0, 200);
          return `- [${n.kind}] "${n.title}" (${linked}, updated ${n.updated_at.slice(0, 10)}): ${preview}`;
        })
        .join("\n")
    : "(no notes yet)";

  return `Current local time: ${now.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: inputs.timezone })}. Standard hours per day: ${weeklyHoursDescription}.
Recurring blocks: ${JSON.stringify(recurringDescription)}
Standing preferences you must ALWAYS honor: ${preferences.length ? preferences.map((n, i) => `${i + 1}. ${n}`).join(" ") : "(none saved yet)"}${researchPriorityNote}
Current state: ${JSON.stringify(snapshot)}
Notes index (previews only — use read_note before editing or relying on a note's contents):
${notesIndex}`;
}

export function buildPlannerSystemPrompt(
  rows: RawScheduleRows,
  inputs: ScheduleInputs,
  schedule: ComputeScheduleResult,
  notes: NoteRow[],
  now: Date = new Date(),
): string {
  return `${buildPlannerPersonaPrompt()}\n${buildPlannerDynamicContext(rows, inputs, schedule, notes, now)}`;
}
