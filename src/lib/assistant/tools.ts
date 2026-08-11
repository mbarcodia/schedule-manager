// The assistant's 9 tools, per the handoff README — ported from the
// prototype's llmTools() (Schedule Manager.dc.html ~776-1010). Each tool
// mutates Supabase directly; the engine re-flows the next time the client
// (or this same request's system-prompt builder) recomputes the schedule.
//
// Tools that resolve a fuzzy title match (project/proposal/task/event) query
// the database fresh rather than trusting the turn-start snapshot, so a
// trackable created earlier in the same conversation turn is visible to a
// later tool call in that turn (e.g. "new proposal X due Friday, with a 2h
// task" → add_trackable then add_task linked to it).

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import {
  parseDeadlineDate,
  parseTimeStr,
  fuzzyFindByTitle,
  findByTitle,
  parseTimeInText,
  normTitle,
  isNowPhrase,
  parseRelativeMinutes,
} from "./nlp-dates";
import { statusReply } from "./status";
import { dateForGday, gdayForDate, localDateKey, minToLabel, zonedTimeToUtc, zonedNow } from "@/lib/scheduling/time";
import { allDayDueAt } from "@/lib/scheduling/all-day-due";
import { computeSchedule } from "@/lib/scheduling/engine";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
// The same helper the board views use. A tool's run() already returns a string,
// so a failed write has somewhere honest to go — and a tool that says "Marked it
// done" over a write that didn't land is the worst version of this bug, because
// the logged hours it invents then drive pace, streaks and the weekly digest.
import { writeError } from "@/lib/planner/write";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, RoutineAnchor } from "@/lib/supabase/database.types";
import type { ScheduleInputs, Task, WeeklyHours } from "@/lib/scheduling/types";
import type { RawScheduleRows } from "@/lib/scheduling/from-db";

/** Set to true by markMutated() the moment any tool successfully writes to
 * the database this turn. The route reads it after a failed model/transport
 * call to say honestly whether a partial write may have already happened,
 * instead of assuming "nothing was changed" (a later iteration in a
 * multi-tool-call turn can fail after an earlier iteration's tool already
 * wrote — the claim isn't automatically true just because the turn as a
 * whole errored). */
export interface MutationTracker {
  mutated: boolean;
}

export interface ToolContext {
  supabase: SupabaseClient<Database>;
  userId: string;
  timezone: string;
  weeklyHours: WeeklyHours;
  horizonWeeks: number;
  /** Today as a civil date (midnight) in the account's timezone. */
  today: Date;
  /** Turn-start snapshot — fine for read-only/status tools; mutation-relevant
   * lookups re-query fresh (see file header). */
  rows: RawScheduleRows;
  inputs: ScheduleInputs;
  mutationTracker: MutationTracker;
}

export function markMutated(ctx: ToolContext): void {
  ctx.mutationTracker.mutated = true;
}

/** A deadline as the user stated it: an exact instant when they named a clock
 * time, otherwise a date-only deadline.
 *
 * This used to plant 5pm on any deadline given without a time, which invented a
 * fact — "due August 11" became "due 5:00 PM August 11", and that hour then
 * drove reminders, display and the engine's ceiling. Date-only is now a real
 * thing the schema can hold (migration 0032), so nothing has to be guessed. */
function titleToDeadlineAt(
  ctx: ToolContext,
  dueLower: string,
): { at: string; allDay: boolean } | null {
  const d = parseDeadlineDate(dueLower, ctx.today);
  if (!d) return null;
  const date = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  const minute = parseTimeInText(dueLower);
  if (minute == null) return { at: allDayDueAt(date, ctx.timezone), allDay: true };
  return {
    at: zonedTimeToUtc(
      date.year,
      date.month,
      date.day,
      Math.floor(minute / 60),
      minute % 60,
      ctx.timezone,
    ).toISOString(),
    allDay: false,
  };
}

/** Earliest date the engine may place a task — the missing counterpart to a
 * deadline. Without it, "tomorrow morning" could only be expressed as
 * time_of_day=morning, which happily placed the work THIS morning. Resolves to
 * the start of that day in the account's timezone. */
function titleToFloorAt(ctx: ToolContext, rawLower: string): string | null {
  const d = parseDeadlineDate(rawLower, ctx.today);
  if (!d) return null;
  const minute = parseTimeInText(rawLower);
  const hour = minute != null ? Math.floor(minute / 60) : 0;
  const min = minute != null ? minute % 60 : 0;
  return zonedTimeToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), hour, min, ctx.timezone).toISOString();
}

export type TrackableLookup =
  | { status: "found"; projectId: string; title: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" };

/** Resolves a project by title. (Was a two-table search until proposals and
 * goals folded in — there is only one place to look now, so a same-titled pair
 * can no longer be silently resolved by search order.) */
export async function findTrackableId(ctx: ToolContext, needle: string): Promise<TrackableLookup> {
  // Archived commitments are excluded on purpose: they are off the boards and out
  // of the schedule, so attaching a task, a target or logged hours to one would
  // write to something the user cannot see. Saying "no project matching that" is
  // the honest answer — add_trackable is what brings one back.
  const { data: projects } = await ctx.supabase
    .from("projects")
    .select("id,title")
    .eq("user_id", ctx.userId)
    .is("archived_at", null);
  const { match, ambiguous } = findByTitle(projects ?? [], needle);
  if (ambiguous.length) return { status: "ambiguous", candidates: ambiguous.map((c) => c.title) };
  if (!match) return { status: "none" };
  console.log(`[assistant] project resolved: needle=${JSON.stringify(needle)} -> id=${match.id} title=${JSON.stringify(match.title)}`);
  return { status: "found", projectId: match.id, title: match.title };
}

function ambiguousMsg(kind: string, needle: string, candidates: { title: string }[]): string {
  return `"${needle}" matches multiple ${kind}: ${candidates.map((c) => c.title).join(", ")}. Say which one (use its exact title).`;
}

/** Fuzzy-matches a category by name (case-insensitive substring, either
 * direction) — returns null silently if no match; callers just omit
 * category_id rather than failing the whole tool call over it. */
export async function findCategoryId(ctx: ToolContext, needle: string): Promise<string | null> {
  const { data: categories } = await ctx.supabase.from("categories").select("id,name").eq("user_id", ctx.userId);
  const n = needle.toLowerCase().trim();
  const match = (categories ?? []).find((c) => {
    const name = c.name.toLowerCase();
    return name.includes(n) || n.includes(name);
  });
  return match?.id ?? null;
}

interface ResolvedPin {
  pinned_date: string;
  pinned_start_min: number;
}

/** Resolves a task-pin's date+time phrase into calendar-date form. Returns
 * null if neither field was given (no pin requested), or a plain string
 * error message if given but unparseable/out of range.
 *
 * "right now" / "asap" / "in 30 minutes" etc. need today's real clock time,
 * not just a phrase — and naturally come with no explicit date ("start this
 * now"), so a now/relative time phrase defaults the date to today rather
 * than erroring for missing it. The resulting start is whatever minute that
 * resolves to (e.g. 11:59), deliberately NOT snapped to the 15-minute grid
 * — the engine tracks busy time minute-by-minute so this still correctly
 * blocks anything else from double-booking it. */
function resolvePin(ctx: ToolContext, dateStr?: string, timeStr?: string): ResolvedPin | string | null {
  if (!dateStr && timeStr == null) return null;
  const nowPhrase = timeStr != null && isNowPhrase(timeStr);
  const relativeMin = timeStr != null ? parseRelativeMinutes(timeStr) : null;
  const effectiveDateStr = (nowPhrase || relativeMin != null) && !dateStr ? "today" : dateStr;
  if (!effectiveDateStr || timeStr == null) return "A pinned time needs both a date and a clock time.";
  const d = parseDeadlineDate(effectiveDateStr.toLowerCase(), ctx.today);
  if (!d) return `Couldn't understand the date "${effectiveDateStr}".`;
  const start =
    nowPhrase || relativeMin != null
      ? Math.min(1439, zonedNow(ctx.timezone).minuteOfDay + (relativeMin ?? 1))
      : parseTimeStr(timeStr);
  if (start == null) return `Couldn't understand the time "${timeStr}" — try "2pm", "14:30", "noon", or "right now".`;
  const gday = gdayForDate(ctx.timezone, { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }, new Date());
  if (gday < 0 || gday >= ctx.horizonWeeks * 7) return gday < 0
      ? `That date is in the past.`
      : `That date is further out than the ${ctx.horizonWeeks}-week (about ${Math.round(ctx.horizonWeeks / 4.35)}-month) planning horizon, so nothing can be placed on it yet. Record it as a note or a target for now, and it becomes schedulable as the date comes into range.`;
  const pinned_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { pinned_date, pinned_start_min: start };
}

/** A pin can't land on top of a real fixed event — that's the one thing the
 * engine can never bump. Everything else (other tasks/research) is fine to
 * displace. */
async function pinConflict(ctx: ToolContext, pin: ResolvedPin, lengthMin: number): Promise<string | null> {
  const { data: events } = await ctx.supabase.from("events").select("title,starts_at,ends_at").is("deleted_at", null).eq("user_id", ctx.userId);
  const [y, mo, da] = pin.pinned_date.split("-").map(Number);
  const pinStart = zonedTimeToUtc(y, mo, da, Math.floor(pin.pinned_start_min / 60), pin.pinned_start_min % 60, ctx.timezone);
  const pinEnd = new Date(pinStart.getTime() + lengthMin * 60000);
  const clash = (events ?? []).find((e) => new Date(e.starts_at) < pinEnd && new Date(e.ends_at) > pinStart);
  return clash ? `That time overlaps your "${clash.title}" event — pick a different time or move the event first.` : null;
}

export function buildTools(ctx: ToolContext) {
  const { supabase, userId } = ctx;

  const add_task = betaTool({
    name: "add_task",
    description: "Add a task: a one-off piece of work with hours the engine schedules. Auto-placed by priority and deadline, inside whatever time-of-day rule the task or its label carries.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        duration_min: { type: "number", description: "total minutes, default 30" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        chunk_min: { type: "number", description: "split into chunks of this many minutes" },
        max_per_day_min: { type: "number", description: "spread it out: schedule at most this many minutes of it per day" },
        split_mode: {
          type: "string",
          enum: ["free", "one_day", "one_block"],
          description:
            'How far it may be spread out. "free" (default) puts pieces wherever they fit. "one_day" still splits it but keeps every piece on a SINGLE day — for "I want to knock this out in a day". "one_block" is one unbroken sitting — for "I need two solid hours on this". The last two are HARD: if no single day or single gap is big enough, the work is left unscheduled and reported, never quietly split. Do not use them unless the user asked for one sitting or one day; chunk_min is the softer lever.',
        },
        min_chunk_min: {
          type: "number",
          description:
            "shortest piece it may ever be cut into, in minutes — a floor, unlike chunk_min which is only the preferred size. OVERRIDES the label's own minimum in both directions, so setting it below the label's is allowed and will be honoured. Mention it when it does.",
        },
        time_of_day: {
          type: "string",
          enum: ["morning", "afternoon"],
          description:
            'Use whenever the user names a general part of the day without an exact clock time (e.g. "schedule this in the afternoon"). "morning" = before noon, "afternoon" = noon or later. For an exact time instead, use pin_date/pin_time.',
        },
        due: {
          type: "string",
          description:
            'Deadline in natural language, e.g. "july 24", "friday", "in 2 weeks". With no clock time this is a DATE-ONLY deadline — due that day, no particular hour — which is what most deadlines are; the work may be scheduled any time up to the end of that working day. Name a time ("2pm november 10", "friday at noon") only when the user actually gave one.',
        },
        not_before: {
          type: "string",
          description:
            'EARLIEST date this may be scheduled ("tomorrow", "monday", "november 9"). Use whenever the user says when the task should START, not when it is due — "tomorrow morning" means not_before="tomorrow" WITH time_of_day="morning". Omitting it lets the engine place it today.',
        },
        project: { type: "string", description: "title of the project to link this task to" },
        category: { type: "string", description: "name of the label to mark this task with — omit to leave unlabelled. A label can carry its own minimum chunk length and time-of-day rule, so labelling something Deep focus may be all that is needed to keep it in the mornings." },
        pin_date: { type: "string", description: 'force part of this work onto an exact date, natural language, e.g. "monday", "july 24" — pairs with pin_time. Anything else scheduled there moves automatically; the rest of it (if any) is still auto-placed.' },
        pin_time: {
          type: "string",
          description:
            'clock time for pin_date, e.g. "2pm", "14:30", "noon", "midnight". Also accepts "right now"/"asap"/"immediately" (starts the next minute) and relative phrases like "in 30 minutes"/"in 2 hours"/"in an hour" — for any of these, pin_date can be omitted and defaults to today.',
        },
        pin_length_min: { type: "number", description: "minutes to pin at that exact time (default: the chunk size); the remaining duration, if any, is auto-placed normally" },
      },
      required: ["title"],
    },
    run: async (inp) => {
      const duration = inp.duration_min || 30;

      let link: { projectId: string; title: string } | null = null;
      if (inp.project) {
        const lookup = await findTrackableId(ctx, inp.project);
        if (lookup.status === "ambiguous") {
          return `"${inp.project}" matches more than one project: ${lookup.candidates.join(", ")}. Say which one (use its exact title), or add the task without a link.`;
        }
        if (lookup.status === "none") {
          return `No project matching "${inp.project}" — add it first, or add the task without a link.`;
        }
        link = { projectId: lookup.projectId, title: lookup.title };
      }

      const categoryId = inp.category ? await findCategoryId(ctx, inp.category) : null;
      const deadline = inp.due ? titleToDeadlineAt(ctx, inp.due.toLowerCase()) : null;
      const deadlineNotUnderstood = !!inp.due && !deadline;
      const notBeforeAt = inp.not_before ? titleToFloorAt(ctx, inp.not_before.toLowerCase()) : null;
      const notBeforeNotUnderstood = !!inp.not_before && !notBeforeAt;
      const priority = inp.priority || "medium";
      const splitMode = inp.split_mode ?? "free";
      // In one sitting the preferred size IS the whole task, whatever was asked
      // for — the engine ignores chunk_min under one_block, and storing a
      // smaller number would leave a row whose two fields contradict each other.
      const chunk_min = splitMode === "one_block" ? duration : inp.chunk_min || (duration > 90 ? 60 : duration);
      // The pair the engine can only answer by scheduling NOTHING, so it is
      // refused here with the reason rather than silently accepted.
      if (splitMode !== "free" && inp.max_per_day_min && inp.max_per_day_min < duration) {
        return `Couldn't add "${inp.title}": it can't be ${splitMode === "one_block" ? "one unbroken block" : "confined to one day"} and also capped at ${inp.max_per_day_min} minutes a day when it's ${duration} minutes of work.`;
      }

      const pin = resolvePin(ctx, inp.pin_date, inp.pin_time);
      if (typeof pin === "string") return `Couldn't add "${inp.title}": ${pin}`;
      const pinLength = pin ? Math.min(inp.pin_length_min || chunk_min, duration) : null;
      if (pin && pinLength) {
        const conflict = await pinConflict(ctx, pin, pinLength);
        if (conflict) return `Couldn't add "${inp.title}": ${conflict}`;
      }

      const payload: Omit<Database["public"]["Tables"]["tasks"]["Insert"], "user_id" | "id"> = {
        title: inp.title,
        priority,
        duration_min: duration,
        chunk_min,
        time_of_day: inp.time_of_day ?? null,
        deadline_at: deadline?.at ?? null,
        deadline_all_day: deadline?.allDay ?? false,
        floor_at: notBeforeAt ?? new Date().toISOString(),
        max_per_day_min: inp.max_per_day_min || null,
        split_mode: splitMode,
        min_chunk_min: inp.min_chunk_min || null,
        project_id: link?.projectId ?? null,
        category_id: categoryId,
        pinned_date: pin?.pinned_date ?? null,
        pinned_start_min: pin?.pinned_start_min ?? null,
        pinned_length_min: pinLength,
      };
      // Said out loud because both are hard constraints that can leave the work
      // OFF the calendar — an outcome nobody should have to discover by looking.
      const splitNote =
        splitMode === "one_block"
          ? ` In one unbroken ${duration}-minute sitting — if no gap that long exists it will stay unscheduled rather than be split.`
          : splitMode === "one_day"
            ? " All on one day — if no single day has room it will stay unscheduled rather than be spread out."
            : "";
      const summary = `(${duration}m, ${priority} priority${link ? ", linked to " + link.title : ""}).${pin ? ` ${pinLength}m pinned to ${inp.pin_date} at ${inp.pin_time} — anything else scheduled there moves automatically.` : inp.time_of_day ? ` Placed in the ${inp.time_of_day}.` : " Placed on the calendar."}${splitNote}${deadlineNotUnderstood ? ` Couldn't understand the deadline "${inp.due}", so no deadline was set — try a format like "july 24" or "in 2 weeks".` : ""}${notBeforeNotUnderstood ? ` Couldn't understand the start date "${inp.not_before}", so it may be scheduled as early as today.` : notBeforeAt ? ` Not scheduled before ${inp.not_before}.` : ""}`;

      // Dedupe on exact (normalized) title — re-declaring a task with the
      // same title updates it in place instead of creating a duplicate.
      //
      // Archived ones are INCLUDED and brought back, exactly as add_trackable
      // does for a commitment: asking for a task by name plainly means you want
      // it. Selecting them without un-archiving was the bug — the update landed
      // on the archived row, which stays invisible, so the task simply never
      // appeared and the tool said it had been saved.
      const { data: existingTasks } = await supabase
        .from("tasks")
        .select("id,title,archived_at,split_mode")
        .eq("user_id", userId);
      const dupe = (existingTasks ?? []).find((t) => normTitle(t.title) === normTitle(inp.title));
      if (dupe) {
        const wasArchived = dupe.archived_at != null;
        // On the UPDATE path the two chunking constraints are only written when
        // this call actually named one. They default to "free"/null, and letting
        // a default overwrite an existing row would mean that re-stating a task
        // ("add npj climate, 2 hours") silently unlocked a rule the user had set
        // — the same shape as the `weekly_research_hrs: 0` bug, and worse here
        // because the setting's whole purpose is to be honoured without being
        // re-checked. An insert still gets both, since there is nothing to lose.
        const update = { ...payload };
        if (inp.split_mode == null) delete update.split_mode;
        if (inp.min_chunk_min == null) delete update.min_chunk_min;
        // chunk_min was derived above from THIS call's split mode, which may not
        // be the one the row keeps. Re-derive against the mode that will
        // actually be stored, so the row's two chunking fields never disagree.
        const keptSplit = inp.split_mode ?? dupe.split_mode ?? "free";
        if (keptSplit === "one_block") update.chunk_min = duration;
        const { error } = await supabase
          .from("tasks")
          .update(wasArchived ? { ...update, archived_at: null } : update)
          .eq("id", dupe.id);
        if (error) return `Couldn't update "${dupe.title}": ${error.message}`;
        markMutated(ctx);
        console.log(`[assistant] add_task upsert: id=${dupe.id} title=${JSON.stringify(dupe.title)}`);
        return `"${dupe.title}" already existed — updated it instead of creating a duplicate ${summary}`;
      }

      const { data: inserted, error } = await supabase.from("tasks").insert({ user_id: userId, ...payload }).select("id").single();
      if (error) return `Couldn't add "${inp.title}": ${error.message}`;
      markMutated(ctx);
      console.log(`[assistant] add_task insert: id=${inserted?.id} title=${JSON.stringify(inp.title)}`);
      return `Added "${inp.title}" ${summary}`;
    },
  });

  const update_task = betaTool({
    name: "update_task",
    description:
      "Modify an existing task and re-flow the whole schedule: change priority, duration, chunking, pacing, due date, or set work_on_next to bump it into the next available slot ahead of everything flexible.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        duration_min: { type: "number" },
        chunk_min: { type: "number" },
        max_per_day_min: { type: "number" },
        split_mode: {
          type: "string",
          enum: ["free", "one_day", "one_block"],
          description:
            'How far it may be spread out. "free" is the default and removes either restriction. "one_day" keeps every piece on a single day; "one_block" is one unbroken sitting. Both are hard: work that will not fit under them is left unscheduled and reported.',
        },
        min_chunk_min: {
          type: "number",
          description:
            "shortest piece it may be cut into, in minutes — a hard floor, unlike chunk_min. Overrides the label's own minimum in both directions. Pass 0 to clear it and fall back to the label's.",
        },
        due: {
          type: "string",
          description:
            "new deadline, natural language. With no clock time it becomes a date-only deadline (due that day, no particular hour); name a time only if the user did. Re-stating a deadline replaces whichever kind it was before.",
        },
        not_before: {
          type: "string",
          description:
            'earliest date this may be scheduled ("tomorrow", "monday", "november 9") — use for "start it tomorrow" style requests, which a deadline alone cannot express',
        },
        category: { type: "string", description: "name of the label to move this task to" },
        time_of_day: {
          type: "string",
          enum: ["morning", "afternoon", "none"],
          description:
            'Use whenever the user names a general part of the day without an exact clock time. "morning" = before noon, "afternoon" = noon or later, "none" clears any existing constraint.',
        },
        work_on_next: { type: "boolean", description: "schedule this at the next available time, ahead of other flexible tasks" },
        important: {
          type: "boolean",
          description:
            "mark (true) or unmark (false) this task as important — the Eisenhower flag on the planning board. Independent of priority, which controls scheduling order.",
        },
        pin_date: { type: "string", description: 'force part of this work onto an exact date, natural language, e.g. "monday", "july 24" — pairs with pin_time. Anything else scheduled there moves automatically; the rest of it (if any) is still auto-placed.' },
        pin_time: {
          type: "string",
          description:
            'clock time for pin_date, e.g. "2pm", "14:30", "noon", "midnight". Also accepts "right now"/"asap"/"immediately" (starts the next minute) and relative phrases like "in 30 minutes"/"in 2 hours"/"in an hour" — for any of these, pin_date can be omitted and defaults to today.',
        },
        pin_length_min: { type: "number", description: "minutes to pin at that exact time (default: its chunk size)" },
        clear_pin: { type: "boolean", description: "remove any pinned time and let this auto-schedule freely again" },
      },
      required: ["title"],
    },
    run: async (inp) => {
      // Archived tasks are out of the schedule, so editing one would write to
      // something the user cannot see and report success. "Nothing matching
      // that" is the honest answer — add_task is what brings one back. Same
      // reasoning findTrackableId already applies to commitments.
      const { data: tasks } = await supabase
        .from("tasks")
        .select("id,title,chunk_min,duration_min,max_per_day_min,split_mode")
        .eq("user_id", userId)
        .is("archived_at", null);
      const { match, ambiguous } = findByTitle(tasks ?? [], inp.title);
      if (ambiguous.length) {
        return `"${inp.title}" matches more than one thing: ${ambiguous.map((t) => t.title).join(", ")}. Say which one (use its exact title).`;
      }
      if (!match) return `Nothing matching "${inp.title}". Current tasks: ${(tasks ?? []).map((t) => t.title).join(", ") || "none"}.`;
      console.log(`[assistant] update_task resolved: needle=${JSON.stringify(inp.title)} -> id=${match.id} title=${JSON.stringify(match.title)}`);

      const patch: Database["public"]["Tables"]["tasks"]["Update"] = {};
      if (inp.priority) patch.priority = inp.priority;
      if (inp.duration_min) patch.duration_min = inp.duration_min;
      if (inp.chunk_min) patch.chunk_min = inp.chunk_min;
      if (inp.max_per_day_min != null) patch.max_per_day_min = inp.max_per_day_min || null;
      if (inp.split_mode) patch.split_mode = inp.split_mode;
      // `!= null`, not truthiness: 0 is the documented way to CLEAR this and
      // fall back to the label's minimum, and a truthy test would drop it.
      if (inp.min_chunk_min != null) patch.min_chunk_min = inp.min_chunk_min || null;

      // Both checks read the row's own values where the call doesn't override
      // them: "make it one block" on a task that already has a daily cap is the
      // same contradiction as setting the two together, and only the merged view
      // can see it.
      const effDuration = inp.duration_min || match.duration_min;
      const effCap = inp.max_per_day_min != null ? inp.max_per_day_min : match.max_per_day_min;
      const effSplit = inp.split_mode ?? match.split_mode;
      if (effSplit !== "free" && effCap && effCap < effDuration) {
        return `Couldn't update "${match.title}": it can't be ${effSplit === "one_block" ? "one unbroken block" : "confined to one day"} and also capped at ${effCap} minutes a day when it's ${effDuration} minutes of work. Nothing was changed.`;
      }
      // One sitting means the preferred size is the whole task — otherwise the
      // row keeps a stale chunk_min that contradicts its own split_mode.
      if (effSplit === "one_block") patch.chunk_min = effDuration;
      if (inp.category) {
        const categoryId = await findCategoryId(ctx, inp.category);
        if (!categoryId) return `No category matching "${inp.category}". Add it first in Settings.`;
        patch.category_id = categoryId;
      }
      if (inp.time_of_day) patch.time_of_day = inp.time_of_day === "none" ? null : inp.time_of_day;
      if (inp.important != null) patch.important = inp.important;
      if (inp.not_before) {
        const floorAt = titleToFloorAt(ctx, inp.not_before.toLowerCase());
        if (!floorAt) {
          return `Couldn't understand the start date "${inp.not_before}" — try "tomorrow", "monday", or "november 9". Nothing was changed.`;
        }
        patch.floor_at = floorAt;
      }
      if (inp.due) {
        const deadline = titleToDeadlineAt(ctx, inp.due.toLowerCase());
        // Fail loudly rather than silently no-op-ing: an unparseable date
        // must not look identical to a successful update to the caller.
        if (!deadline) {
          return `Couldn't understand the deadline "${inp.due}" — try a format like "july 24", "friday", or "in 2 weeks". Nothing was changed.`;
        }
        patch.deadline_at = deadline.at;
        // Re-stated deadlines re-decide this: "due friday at 2pm" after "due
        // friday" must stop being date-only, and the reverse must clear the time.
        patch.deadline_all_day = deadline.allDay;
      }
      if (inp.work_on_next) {
        patch.ord = 0;
        patch.priority = inp.priority || "high";
        patch.floor_at = new Date().toISOString();
      }
      let pinMessage = "";
      if (inp.clear_pin) {
        patch.pinned_date = null;
        patch.pinned_start_min = null;
        patch.pinned_length_min = null;
      } else if (inp.pin_date || inp.pin_time != null) {
        const pin = resolvePin(ctx, inp.pin_date, inp.pin_time);
        if (typeof pin === "string") return `Couldn't update "${match.title}": ${pin}`;
        if (pin) {
          const chunkMin = inp.chunk_min || match.chunk_min;
          const durationMin = inp.duration_min || match.duration_min;
          const pinLength = Math.min(inp.pin_length_min || chunkMin, durationMin);
          const conflict = await pinConflict(ctx, pin, pinLength);
          if (conflict) return `Couldn't update "${match.title}": ${conflict}`;
          patch.pinned_date = pin.pinned_date;
          patch.pinned_start_min = pin.pinned_start_min;
          patch.pinned_length_min = pinLength;
          pinMessage = ` ${pinLength}m pinned to ${inp.pin_date} at ${inp.pin_time} — anything else scheduled there moves automatically.`;
        }
      }
      if (Object.keys(patch).length === 0) {
        return `Nothing to change for "${match.title}" — no recognized fields were provided.`;
      }
      const { error } = await supabase.from("tasks").update(patch).eq("id", match.id);
      if (error) return `Couldn't update "${match.title}": ${error.message}`;
      markMutated(ctx);
      return `Updated "${match.title}"${inp.work_on_next ? " — it now takes the next available slot and everything else re-flows around it" : ""}${pinMessage}${inp.clear_pin ? " — pin removed, it auto-schedules freely again." : ""}${!inp.work_on_next && !pinMessage && !inp.clear_pin ? " — schedule re-flowed" : ""}`;
    },
  });

  // Nothing this tool does is irreversible, and that is deliberate.
  //
  // It resolves a title by fuzzy match — the right behaviour for "log 45 minutes
  // on grading" and the wrong behaviour for destroying a row. A needle scoring
  // over 0.35 against exactly one candidate is acted on with no confirmation, so
  // "remove the analysis" could once have permanently deleted a task nobody
  // named, along with the hours logged against it. The match is unchanged; what
  // changed is that being wrong is now recoverable.
  //
  // Tasks and projects archive. Targets and events go to Trash. The
  // delete_permanently escape hatch is gone rather than gated: an escape hatch
  // reachable by a model that has already mis-resolved the title is not a
  // safeguard, and there is a Trash view for the case where the user genuinely
  // wants a record gone.
  const remove_item = betaTool({
    name: "remove_item",
    description:
      "Remove a task, project, target or event by title. Nothing is destroyed: a task or project is ARCHIVED (off the boards, no longer scheduled, logged hours and dates kept, restorable from the Archive tab), and a target or event goes to TRASH (hidden everywhere, restorable from the Trash tab). Both are reversible, so this is safe to run when the user asks to remove something. You cannot permanently delete anything — if the user wants a record gone for good, tell them to empty it from the Trash tab themselves.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    },
    run: async ({ title }) => {
      const [{ data: tasks }, { data: projects }, { data: targets }, { data: events }] = await Promise.all([
        supabase.from("tasks").select("id,title").eq("user_id", userId),
        supabase.from("projects").select("id,title").eq("user_id", userId),
        supabase.from("targets").select("id,title").is("deleted_at", null).eq("user_id", userId),
        supabase.from("events").select("id,title").is("deleted_at", null).eq("user_id", userId),
      ]);

      const tMatch = findByTitle(tasks ?? [], title);
      if (tMatch.ambiguous.length) return ambiguousMsg("tasks", title, tMatch.ambiguous);
      const t = tMatch.match;
      if (t) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> task id=${t.id} title=${JSON.stringify(t.title)}`);
        // Archived, not deleted — and its progress_log rows are left exactly
        // where they are. Clearing them was the old behaviour and it destroyed
        // the answer to "what did I get done this semester?" for any task that
        // was later removed. An archived task is invisible to the scheduler and
        // the boards; its hours still count in the record.
        const { data: archived, error } = await supabase
          .from("tasks")
          .update({ archived_at: new Date().toISOString() })
          .eq("id", t.id)
          .is("archived_at", null)
          .select("id");
        if (error) return `Couldn't remove "${t.title}": ${error.message}`;
        if (!archived || archived.length === 0) return `"${t.title}" was already archived.`;
        markMutated(ctx);
        return `Archived "${t.title}" — it's off the calendar and the boards, its logged hours are kept, and you can restore it from the Archive tab.`;
      }
      const tgMatch = findByTitle(targets ?? [], title);
      if (tgMatch.ambiguous.length) return ambiguousMsg("targets", title, tgMatch.ambiguous);
      const tg = tgMatch.match;
      if (tg) {
        const { data: trashed, error } = await supabase
          .from("targets")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", tg.id)
          .is("deleted_at", null)
          .select("id");
        if (error) return `Couldn't remove "${tg.title}": ${error.message}`;
        if (!trashed || trashed.length === 0) return `"${tg.title}" was already in the Trash.`;
        markMutated(ctx);
        return `Moved the target "${tg.title}" to Trash — restore it from the Trash tab if that was the wrong one.`;
      }
      const cMatch = findByTitle(projects ?? [], title);
      if (cMatch.ambiguous.length) return ambiguousMsg("projects", title, cMatch.ambiguous);
      const c = cMatch.match;
      if (c) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> project id=${c.id} title=${JSON.stringify(c.title)}`);

        // Archiving is the ONLY thing that happens here now. Deleting a
        // commitment took its progress_log rows and its targets with it — the
        // one place in this app where finishing something destroyed the record
        // of doing it — and the permanent path has been removed rather than
        // gated, because the title that got here was resolved by fuzzy match.
        const { error } = await supabase
          .from("projects")
          .update({ archived_at: new Date().toISOString() })
          .eq("id", c.id);
        if (error) return `Couldn't archive "${c.title}": ${error.message}`;
        markMutated(ctx);
        return `Archived "${c.title}" — it's off the boards and nothing more is scheduled for it, but its logged hours, dates, targets and estimate are all kept. Restore it from the Archive tab, or say so here.`;
      }
      const evMatch = findByTitle(events ?? [], title);
      if (evMatch.ambiguous.length) return ambiguousMsg("events", title, evMatch.ambiguous);
      const ev = evMatch.match;
      if (ev) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> event id=${ev.id} title=${JSON.stringify(ev.title)}`);
        const { data: trashed, error } = await supabase
          .from("events")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", ev.id)
          .is("deleted_at", null)
          .select("id");
        if (error) return `Couldn't remove "${ev.title}": ${error.message}`;
        if (!trashed || trashed.length === 0) return `"${ev.title}" was already in the Trash.`;
        markMutated(ctx);
        return `Moved event "${ev.title}" to Trash — the freed time refills automatically, and you can restore it from the Trash tab.`;
      }
      const all = [...(tasks ?? []), ...(targets ?? []), ...(projects ?? [])];
      return `Nothing matching "${title}" found. Current items: ${all.map((x) => x.title).join(", ") || "none"}.`;
    },
  });

  const add_trackable = betaTool({
    name: "add_trackable",
    description:
      "Add or update a PROJECT — anything ongoing the user has signed up for (a research project, a proposal, a course, a standing aim). One kind of thing with optional facets, any combination legal: weekly hours the engine defends, a hard deadline, an active window for when those hours apply, which half of the day they belong in, a cadence. Re-declaring an existing title updates it in place rather than creating a duplicate, so this is also how you change a project.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        due: { type: "string", description: 'hard deadline for the whole project, natural language, e.g. "december 31", "in 2 weeks". Pass "none" to remove an existing deadline.' },
        weekly_research_hrs: { type: "number", description: "hours per week the engine must find and defend for this project" },
        active_from: {
          type: "string",
          description:
            'the weekly hours only start applying from this date, natural language, e.g. "december 1". Without it the hours are booked from today, which is wrong for anything that starts next term.',
        },
        active_until: { type: "string", description: 'the weekly hours stop applying after this date. Pass "none" to remove either end of the window.' },
        hours_time_of_day: {
          type: "string",
          enum: ["morning", "afternoon", "any"],
          description:
            'Where this project\'s weekly hours must go. "morning"/"afternoon" is a HARD restriction: the engine refuses the other half of the day even when that means the hours do not fit, which caps a big weekly minimum at whatever one half-day holds. "any" removes that restriction (mornings are still tried first, then afternoons as needed) and is how you undo it. OMITTING this leaves whatever is already set — it does NOT reset it, so pass "any" explicitly to unlock a project.',
        },
        cadence: { type: "string", description: 'rhythm for a project with no deadline, e.g. "Weekly", "Ongoing". Descriptive only — nothing is scheduled from it. Pass "none" to remove it.' },
        total_effort_hrs: {
          type: "number",
          description:
            "TOTAL expected effort for the whole project, in hours — not per week. This is what makes pace measurable: without it the app cannot say whether the project is keeping up, because it knows the weekly rate and the date but not how much work is left. Ask for a rough figure rather than leaving it unset; it is meant to be revised as logged hours show how wrong it was.",
        },
        deadline_kind: {
          type: "string",
          enum: ["hard", "goal"],
          description:
            'Whether `due` is externally imposed ("hard" — a submission or funder date that cannot move) or self-set ("goal" — a date you are aiming for). Both are scheduled toward identically; the difference is what happens when one will be missed. Ask which it is rather than assuming, and default to "goal" for anything the user chose themselves.',
        },
        important: {
          type: "boolean",
          description: "Mark this project important — the importance axis of the Priorities board. Urgency is read from its dates; importance is only ever the user's call, so ask rather than inferring it.",
        },
        category: { type: "string", description: "name of the label for this project's weekly-hours blocks" },
        on_hold: {
          type: "boolean",
          description:
            'Put this commitment on hold (true) or pick it back up (false). ON HOLD = recorded and visible, but the engine schedules NOTHING for it — neither its weekly hours nor its tasks — and it claims no part of its label\'s weekly share. Its weekly hours are REMEMBERED, not cleared, so resuming returns it to the same rate. Use this whenever someone describes work they are keeping track of but not doing yet, or pausing for now; it is the honest alternative to deleting the hours, which throws away a decision. Different from archiving, which means finished. Its dates still approach, and pace will speak up if the work left stops fitting before one.',
        },
      },
      required: ["title"],
    },
    run: async (inp) => {
      const toDateString = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      /** "none" is an explicit erase, distinct from an omitted field (leave as
       * is) and from an unparseable one (say so, change nothing). Without the
       * distinction there was no way to remove a facet at all. */
      const CLEAR = new Set(["none", "no deadline", "never", "clear", "remove", "unset"]);
      const parseDate = (text: string | undefined) => {
        if (!text) return { value: null as string | null, failed: false, clear: false };
        if (CLEAR.has(text.trim().toLowerCase())) return { value: null as string | null, failed: false, clear: true };
        const d = parseDeadlineDate(text.toLowerCase(), ctx.today);
        return { value: d ? toDateString(d) : null, failed: !d, clear: false };
      };

      const deadline = parseDate(inp.due);
      const from = parseDate(inp.active_from);
      const until = parseDate(inp.active_until);
      const unparsed = [
        inp.due && deadline.failed ? `deadline "${inp.due}"` : null,
        inp.active_from && from.failed ? `active-from date "${inp.active_from}"` : null,
        inp.active_until && until.failed ? `active-until date "${inp.active_until}"` : null,
      ].filter(Boolean);
      const dateNote = unparsed.length
        ? ` Couldn't understand the ${unparsed.join(" or the ")}, so ${unparsed.length > 1 ? "those were" : "that was"} left unset — try a format like "friday" or "aug 3".`
        : "";
      // The database rejects an inverted window; catching it here explains why
      // instead of surfacing a constraint violation.
      if (from.value && until.value && from.value > until.value) {
        return `The active window ends (${until.value}) before it starts (${from.value}) — check those two dates.`;
      }

      const categoryId = inp.category ? await findCategoryId(ctx, inp.category) : null;

      const patch: Database["public"]["Tables"]["projects"]["Update"] = { title: inp.title };
      if (deadline.value) patch.deadline_date = deadline.value;
      else if (deadline.clear) patch.deadline_date = null;
      if (from.value) patch.active_from = from.value;
      else if (from.clear) patch.active_from = null;
      if (until.value) patch.active_until = until.value;
      else if (until.clear) patch.active_until = null;
      if (inp.cadence) patch.cadence = CLEAR.has(inp.cadence.trim().toLowerCase()) ? null : inp.cadence;
      if (inp.total_effort_hrs != null) patch.effort_estimate_min = Math.round(inp.total_effort_hrs * 60);
      if (inp.deadline_kind) patch.deadline_kind = inp.deadline_kind;
      if (inp.important != null) patch.important = inp.important;
      if (inp.on_hold != null) patch.on_hold_at = inp.on_hold ? new Date().toISOString() : null;
      if (categoryId) patch.category_id = categoryId;
      // "any" erases the hard restriction. Previously only "morning" and
      // "afternoon" existed and an omitted field meant "leave it", so a project
      // locked to mornings could never be unlocked: the tool accepted the
      // request, wrote nothing, and reported success — which read as the change
      // having been made while research stayed capped at what one morning holds.
      if (inp.hours_time_of_day === "any") patch.time_of_day = null;
      else if (inp.hours_time_of_day) patch.time_of_day = inp.hours_time_of_day;
      if (inp.weekly_research_hrs != null) {
        // 0 means "stop defending time for this", and the column is
        // `check (> 0)` — so it has to become NULL, exactly as the insert path
        // below already does. Writing a literal 0 was rejected by Postgres and
        // surfaced as an unreadable constraint error.
        patch.weekly_min_min = inp.weekly_research_hrs > 0 ? inp.weekly_research_hrs * 60 : null;
        // Mornings-first stays the default for weekly hours, but an explicit
        // half-of-day wins — that's the whole point of the facet.
        patch.prefer_morning = inp.hours_time_of_day !== "afternoon";
      }

      const facets = [
        inp.weekly_research_hrs != null
          ? inp.weekly_research_hrs > 0
            ? `${inp.weekly_research_hrs}h/wk`
            : "no weekly hours — nothing is booked for it now"
          : null,
        deadline.value ? `due ${deadline.value}` : null,
        from.value || until.value
          ? `hours apply ${from.value ? `from ${from.value}` : "from now"}${until.value ? ` until ${until.value}` : ""}`
          : null,
        inp.hours_time_of_day === "any"
          ? "hours may go any time of day"
          : inp.hours_time_of_day
            ? `${inp.hours_time_of_day}s only`
            : null,
        inp.cadence ? inp.cadence.toLowerCase() : null,
        inp.total_effort_hrs != null ? `${inp.total_effort_hrs}h total effort` : null,
        inp.deadline_kind ? `${inp.deadline_kind} date` : null,
        inp.important === true ? "important" : inp.important === false ? "not important" : null,
        inp.on_hold === true ? "ON HOLD — nothing scheduled for it, its weekly hours kept for when it resumes" : null,
        inp.on_hold === false ? "off hold — its hours are being scheduled again" : null,
      ].filter(Boolean);
      const summary = facets.length ? ` — ${facets.join(", ")}.${dateNote}` : `.${dateNote}`;

      // Dedupe on exact (normalized) title: re-declaring a project that
      // already exists updates it rather than making a second one. Archived ones
      // are INCLUDED in this lookup — leaving them out would create a second
      // commitment with the same name whose history lives on the first, and
      // re-declaring one you had put away plainly means you are working on it
      // again, so it comes back rather than being updated while still invisible.
      const { data: existing } = await supabase
        .from("projects")
        .select("id,title,archived_at,on_hold_at")
        .eq("user_id", userId);
      const dupe = (existing ?? []).find((p) => normTitle(p.title) === normTitle(inp.title));
      if (dupe) {
        const wasArchived = dupe.archived_at != null;
        // Re-declaring one that is on hold takes it OFF hold, on the same
        // argument that un-archives: describing the work you want done means
        // you want it done. Unless this very call is what put it on hold.
        const wasHeld = dupe.on_hold_at != null && inp.on_hold !== true;
        const { error } = await supabase
          .from("projects")
          .update({
            ...patch,
            ...(wasArchived ? { archived_at: null } : {}),
            ...(wasHeld ? { on_hold_at: null } : {}),
          })
          .eq("id", dupe.id);
        if (error) return `Couldn't update the project: ${error.message}`;
        markMutated(ctx);
        console.log(`[assistant] add_trackable upsert: project id=${dupe.id} title=${JSON.stringify(dupe.title)} restored=${wasArchived}`);
        if (wasArchived) {
          return `"${dupe.title}" was archived — brought it back with its logged hours, dates and estimate intact${summary}`;
        }
        if (wasHeld) {
          return `"${dupe.title}" was on hold — took it off hold, so its weekly hours are being scheduled again${summary}`;
        }
        return `"${dupe.title}" already existed — updated it instead of creating a duplicate${summary}`;
      }
      const { data: inserted, error } = await supabase
        .from("projects")
        .insert({
          user_id: userId,
          title: inp.title,
          deadline_date: deadline.value,
          weekly_min_min: inp.weekly_research_hrs ? inp.weekly_research_hrs * 60 : null,
          prefer_morning: !!inp.weekly_research_hrs && inp.hours_time_of_day !== "afternoon",
          time_of_day: inp.hours_time_of_day === "any" ? null : (inp.hours_time_of_day ?? null),
          active_from: from.value,
          active_until: until.value,
          cadence: inp.cadence ?? null,
          effort_estimate_min: inp.total_effort_hrs != null ? Math.round(inp.total_effort_hrs * 60) : null,
          deadline_kind: inp.deadline_kind ?? (inp.due ? "hard" : "goal"),
          important: inp.important ?? false,
          on_hold_at: inp.on_hold ? new Date().toISOString() : null,
          chunk_min: 120,
          research_ord: 5,
          category_id: categoryId,
        })
        .select("id")
        .single();
      if (error) return `Couldn't add the project: ${error.message}`;
      markMutated(ctx);
      console.log(`[assistant] add_trackable insert: project id=${inserted?.id} title=${JSON.stringify(inp.title)}`);
      return `Project "${inp.title}" added${summary}`;
    },
  });

  const add_target = betaTool({
    name: "add_target",
    description:
      'Add a TARGET: a dated checkpoint inside a project that consumes NO calendar hours ("first round of analysis done by the end of August"). Use this for the interim dates inside a long project instead of inventing a task with a made-up duration — a target competes for nothing, which is why it exists. If hitting it needs hours, that is a separate add_task. Re-using an existing target title within the same project moves its date.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        project: { type: "string", description: "fuzzy title of the project this target belongs to" },
        date: { type: "string", description: 'natural language, e.g. "end of august", "october 31"' },
        date_kind: {
          type: "string",
          enum: ["hard", "goal"],
          description:
            'Whether this checkpoint is externally imposed ("hard") or one the user set for themselves ("goal", the default and the usual case for an interim date). Pace is measured against the soonest unmet target either way; the difference is whether missing it is a problem to solve or a date to move.',
        },
        hours: {
          type: "number",
          description:
            "How much of the project's effort this phase alone is expected to take — not the running total. Give it whenever it's known: pace then measures the hours due by this date rather than the project's whole remaining effort against it, which otherwise reports a two-week checkpoint as months behind. Omit if the checkpoint isn't a slice of the work (a meeting, a decision). Pass 0 to remove a figure already set — the panel's empty field means the same thing.",
        },
      },
      required: ["title", "project", "date"],
    },
    run: async (inp) => {
      const lookup = await findTrackableId(ctx, inp.project);
      if (lookup.status === "ambiguous") {
        return `"${inp.project}" matches more than one project: ${lookup.candidates.join(", ")}. Say which one (use its exact title).`;
      }
      if (lookup.status === "none") return `No project matching "${inp.project}" — add it first.`;

      const d = parseDeadlineDate(inp.date.toLowerCase(), ctx.today);
      if (!d) return `Couldn't understand the date "${inp.date}" — try a format like "october 31" or "end of august".`;
      const target_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const { data: existing } = await supabase
        .from("targets")
        .select("id,title")
        .is("deleted_at", null)
        .eq("commitment_id", lookup.projectId);
      // `hours != null`, not `if (inp.hours)`: 0 is a real instruction here —
      // erase the figure, which is what the panel's empty field stores. Testing
      // truthiness would have made it a silent no-op, which is the shape of
      // several bugs in this file's history.
      const effort =
        inp.hours == null ? {} : { effort_estimate_min: inp.hours > 0 ? Math.round(inp.hours * 60) : null };
      const dupe = (existing ?? []).find((t) => normTitle(t.title) === normTitle(inp.title));
      if (dupe) {
        const { error } = await supabase
          .from("targets")
          .update({ target_date, ...(inp.date_kind ? { date_kind: inp.date_kind } : {}), ...effort })
          .eq("id", dupe.id);
        if (error) return `Couldn't move that target: ${error.message}`;
        markMutated(ctx);
        const hoursNote =
          inp.hours == null ? "" : inp.hours > 0 ? `, ${inp.hours}h of work due by then` : ", and its hours figure removed";
        return `Moved "${dupe.title}" to ${target_date} (${lookup.title})${hoursNote}.`;
      }
      const { error } = await supabase
        .from("targets")
        .insert({
          user_id: userId,
          commitment_id: lookup.projectId,
          title: inp.title,
          target_date,
          date_kind: inp.date_kind ?? "goal",
          ...effort,
        });
      if (error) return `Couldn't add that target: ${error.message}`;
      markMutated(ctx);
      return (
        `Target "${inp.title}" set for ${target_date} under ${lookup.title} (${inp.date_kind ?? "goal"} date). ` +
        `It takes no calendar time, and pace is now measured against it` +
        (inp.hours != null && inp.hours > 0
          ? ` — ${inp.hours}h of the project's effort is due by then.`
          : `. Only this phase's own hours are missing: without them pace compares the project's WHOLE remaining effort against this date, which reads as badly behind for any near checkpoint.`)
      );
    },
  });

  const plan_phases = betaTool({
    name: "plan_phases",
    description:
      "Break a project into phases and set a GOAL DATE for each by working out when each one can actually be finished. " +
      "This is backward planning done against real capacity rather than a calendar: it uses the hours the engine has actually " +
      "placed for this project week by week, so travel weeks, conference weeks and days off are skipped instead of being " +
      "assumed available. Use it when a project has a final date and phases but no interim dates — interim dates are what " +
      "make progress visible, and a project with only a final date gives no signal until it is too late. " +
      "Each phase becomes a target: a date, and the hours due by it, but no calendar time of its own. Phase hours are " +
      "optional: without them the total effort estimate is split evenly and the reply says so.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "fuzzy title of the project" },
        phases: {
          type: "array",
          items: { type: "string" },
          description: 'the phases in order, e.g. ["run simulations", "process data", "analysis", "write up"]',
        },
        phase_hours: {
          type: "array",
          items: { type: "number" },
          description:
            "hours for each phase, in the same order as `phases`. Omit to split the project's total effort estimate evenly — but ask first, since later phases rarely take as long as earlier ones.",
        },
      },
      required: ["project", "phases"],
    },
    run: async (inp) => {
      const lookup = await findTrackableId(ctx, inp.project);
      if (lookup.status === "ambiguous") {
        return `"${inp.project}" matches more than one project: ${lookup.candidates.join(", ")}. Say which one.`;
      }
      if (lookup.status === "none") return `No project matching "${inp.project}".`;
      if (!inp.phases.length) return "Give at least one phase.";
      if (inp.phase_hours && inp.phase_hours.length !== inp.phases.length) {
        return `You gave ${inp.phases.length} phases but ${inp.phase_hours.length} hour figures — they have to line up.`;
      }

      const rows = await queryScheduleRows(supabase, userId);
      const { inputs } = buildScheduleInputs(rows);
      const project = inputs.projects.find((p) => p.id === lookup.projectId);
      if (!project) return `Couldn't load "${lookup.title}".`;

      // Split the total estimate evenly when no per-phase figures were given.
      let hours = inp.phase_hours;
      let evenSplit = false;
      if (!hours) {
        if (!project.effortEstimateMin) {
          return `"${lookup.title}" has no total effort estimate and no per-phase hours were given, so there is nothing to spread across the phases. Either set a total (add_trackable's total_effort_hrs) or pass phase_hours.`;
        }
        const each = project.effortEstimateMin / 60 / inp.phases.length;
        hours = inp.phases.map(() => each);
        evenSplit = true;
      }

      // Walk the hours the engine has ACTUALLY placed for this project, in order,
      // and note the date at which each phase's cumulative hours are reached.
      // That's what makes the dates achievable rather than arithmetic: a week the
      // project gets nothing contributes nothing.
      const schedule = computeSchedule(inputs);
      const placed = schedule.blocks
        // gday >= 0: the schedule now carries past weeks as a record, and counting
        // already-worked hours as future capacity would date every phase early.
        .filter((b) => b.type === "task" && b.gday >= 0 && b.projectId === lookup.projectId)
        .sort((a, b) => a.gday * 1440 + a.start - (b.gday * 1440 + b.start));
      if (!placed.length) {
        return `Nothing is currently scheduled for "${lookup.title}", so there is no pace to derive dates from. Give it weekly hours first (add_trackable's weekly_research_hrs).`;
      }

      const cumulativeTargets = hours.map((h, i) => hours!.slice(0, i + 1).reduce((a, b) => a + b, 0) * 60);
      const dates: (string | null)[] = cumulativeTargets.map(() => null);
      let run = 0;
      let next = 0;
      for (const b of placed) {
        run += b.end - b.start;
        while (next < cumulativeTargets.length && run >= cumulativeTargets[next]) {
          const d = dateForGday(ctx.timezone, b.gday);
          dates[next] = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
          next++;
        }
        if (next >= cumulativeTargets.length) break;
      }

      const written: string[] = [];
      const phaseFailures: string[] = [];
      const unreachable: string[] = [];
      for (let i = 0; i < inp.phases.length; i++) {
        const title = inp.phases[i];
        const on = dates[i];
        if (!on) {
          unreachable.push(`${title} (${hours[i]}h)`);
          continue;
        }
        const { data: existing } = await supabase
          .from("targets")
          .select("id,title")
          .is("deleted_at", null)
          .eq("commitment_id", lookup.projectId);
        // Keep the phase's hours, not just the date they imply. Pace needs them
        // to measure this checkpoint rather than the whole project against it,
        // and they were being discarded after the dates were derived from them.
        const effort_estimate_min = Math.round(hours[i] * 60);
        const dupe = (existing ?? []).find((t) => normTitle(t.title) === normTitle(title));
        // Collected rather than thrown: this writes several phases in a loop,
        // and reporting "planned 4 phases" when the third failed is the shape
        // of every "it said it saved" bug in this file.
        const { error: phaseErr } = dupe
          ? await supabase
              .from("targets")
              .update({ target_date: on, date_kind: "goal", effort_estimate_min })
              .eq("id", dupe.id)
          : await supabase.from("targets").insert({
              user_id: userId,
              commitment_id: lookup.projectId,
              title,
              target_date: on,
              date_kind: "goal",
              effort_estimate_min,
            });
        if (phaseErr) {
          phaseFailures.push(`${title} (${phaseErr.message})`);
          continue;
        }
        written.push(`${title} (${hours[i]}h) — goal ${on}`);
      }
      markMutated(ctx);

      const rate = project.weeklyMinMin ? `${project.weeklyMinMin / 60}h/wk` : "its current pace";
      const deadlineNote = project.deadlineDate
        ? (() => {
            const last = dates[dates.length - 1];
            if (!last) return ` The final phase doesn't fit inside the planning horizon at ${rate}.`;
            const over = new Date(last) > project.deadlineDate;
            return over
              ? ` That lands the last phase after the ${project.deadlineKind ?? "hard"} deadline of ${localDateKey(project.deadlineDate)} — the hours per week or the scope has to change.`
              : ` The last phase lands on ${last}, inside the ${project.deadlineKind ?? "hard"} deadline of ${localDateKey(project.deadlineDate)}.`;
          })()
        : "";

      return (
        `Phase dates for ${lookup.title}, derived from the ${rate} actually on the calendar (travel and days off skipped):\n` +
        written.map((w) => `  ${w}`).join("\n") +
        (unreachable.length
          ? `\nNot reachable within the planning horizon at this rate: ${unreachable.join(", ")}.`
          : "") +
        (phaseFailures.length ? `\nTHESE DID NOT SAVE and need trying again: ${phaseFailures.join("; ")}.` : "") +
        deadlineNote +
        (evenSplit
          ? ` Hours were split evenly across the phases because none were given — worth revising, since writing up rarely takes as long as the analysis.`
          : "")
      );
    },
  });

  const complete_target = betaTool({
    name: "complete_target",
    description:
      "Mark a target hit, or un-mark it. Targets are kept rather than deleted once hit, so a project reads as a sequence of dates made or missed.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "fuzzy title of the target" },
        done: { type: "boolean", description: "default true; false un-marks it" },
      },
      required: ["title"],
    },
    run: async (inp) => {
      const { data: targets } = await supabase
        .from("targets")
        .select("id,title,target_date")
        .is("deleted_at", null)
        .eq("user_id", userId);
      const { match, ambiguous } = findByTitle(targets ?? [], inp.title);
      if (ambiguous.length) return ambiguousMsg("targets", inp.title, ambiguous);
      if (!match) return `No target matching "${inp.title}".`;
      const done = inp.done !== false;
      const { error } = await supabase
        .from("targets")
        .update({ completed_at: done ? new Date().toISOString() : null })
        .eq("id", match.id);
      if (error) return `Couldn't update that target: ${error.message}`;
      markMutated(ctx);
      return done ? `"${match.title}" marked hit.` : `"${match.title}" is open again.`;
    },
  });

  const add_event = betaTool({
    name: "add_event",
    description:
      "Add a fixed calendar event (meeting, appointment). It blocks that time; any auto-scheduled task sitting there is automatically moved while keeping its deadline, total hours, and pacing rules.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: 'natural language: "today", "tomorrow", "friday", "july 22"' },
        start_time: { type: "string", description: '"2pm", "14:30"' },
        duration_min: { type: "number", description: "default 60" },
      },
      required: ["title", "start_time"],
    },
    run: async (inp) => {
      let dateObj = new Date(ctx.today);
      if (inp.date && !/today/.test(inp.date.toLowerCase())) {
        const d = parseDeadlineDate(inp.date.toLowerCase(), ctx.today);
        if (d) dateObj = d;
      }
      const gday = gdayForDate(ctx.timezone, { year: dateObj.getFullYear(), month: dateObj.getMonth() + 1, day: dateObj.getDate() }, new Date());
      if (gday < 0 || gday >= ctx.horizonWeeks * 7) return gday < 0
      ? `That date is in the past.`
      : `That date is further out than the ${ctx.horizonWeeks}-week (about ${Math.round(ctx.horizonWeeks / 4.35)}-month) planning horizon, so nothing can be placed on it yet. Record it as a note or a target for now, and it becomes schedulable as the date comes into range.`;

      const start = parseTimeStr(inp.start_time);
      if (start == null) return 'Give a start time like "2pm" or "14:30".';
      const dur = inp.duration_min || 60;

      const starts_at = zonedTimeToUtc(
        dateObj.getFullYear(),
        dateObj.getMonth() + 1,
        dateObj.getDate(),
        Math.floor(start / 60),
        start % 60,
        ctx.timezone,
      );
      const ends_at = new Date(starts_at.getTime() + dur * 60000);

      const { error } = await supabase.from("events").insert({
        user_id: userId,
        title: inp.title,
        starts_at: starts_at.toISOString(),
        ends_at: ends_at.toISOString(),
        source: "manual",
      });
      if (error) return `Couldn't add event: ${error.message}`;
      markMutated(ctx);
      const weekLabel = Math.floor(gday / 7);
      return `Added "${inp.title}" ${weekLabel ? `(${weekLabel} week${weekLabel > 1 ? "s" : ""} out) ` : ""}at the requested time. Anything that was scheduled there has been moved automatically.`;
    },
  });

  const adjust_day_hours = betaTool({
    name: "adjust_day_hours",
    description:
      "Change ONE date's working hours: a later start, an earlier end, nothing at all, or back to normal. Displaced tasks reschedule automatically. Use `off` for a holiday or a day taken back — a one-minute window is not the same thing. Use `back_to_standard` to remove the exception entirely, which is different from re-typing the standard hours into it: the standard hours can change later, and only a removed exception follows them.",
    inputSchema: {
      type: "object",
      properties: {
        day: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
        weeks_from_now: { type: "number", description: "0 = this week (default), 1 = next week, ..." },
        start_hour: { type: "number", description: "24h clock, e.g. 11" },
        end_hour: { type: "number", description: "24h clock, e.g. 15" },
        allow_weekend: { type: "boolean", description: "explicitly allow scheduling on this Saturday/Sunday" },
        off: {
          type: "boolean",
          description:
            "Nothing is scheduled that date at all, whatever the weekday's normal hours say — a holiday, a day of travel, a day taken back. Pass false to re-open a day that was closed; the hours it had are kept, so it returns to those.",
        },
        back_to_standard: {
          type: "boolean",
          description:
            "Remove the exception for this date so it follows the weekday's standard hours again, now and if those hours change later. Overrides the other fields.",
        },
      },
      required: ["day"],
    },
    run: async (inp) => {
      const weekdayMap: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
      const dayIdx = weekdayMap[inp.day];
      const gday = (inp.weeks_from_now || 0) * 7 + dayIdx;
      const d = new Date(ctx.today);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + gday); // this week's Monday + gday
      const override_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const { data: existing } = await supabase
        .from("day_overrides")
        .select("*")
        .eq("user_id", userId)
        .eq("override_date", override_date)
        .maybeSingle();

      // Deleting the row, not writing today's standard hours into it: a stored
      // copy of the default stops following the default the moment it changes.
      if (inp.back_to_standard) {
        if (!existing) return `${inp.day} already follows your standard hours.`;
        const { error } = await supabase.from("day_overrides").delete().eq("id", existing.id);
        if (error) return `Couldn't reset that day: ${error.message}`;
        markMutated(ctx);
        return `${inp.day} follows your standard hours again.`;
      }

      const patch = {
        user_id: userId,
        override_date,
        start_min: inp.start_hour != null ? inp.start_hour * 60 : (existing?.start_min ?? null),
        end_min: inp.end_hour != null ? inp.end_hour * 60 : (existing?.end_min ?? null),
        allow_weekend: inp.allow_weekend ?? existing?.allow_weekend ?? false,
        // `!= null`, not truthiness: `off: false` is a real instruction (re-open
        // a closed day) and must not read as "leave it alone".
        closed: inp.off != null ? inp.off : (existing?.closed ?? false),
      };
      const { error } = await supabase
        .from("day_overrides")
        .upsert(patch, { onConflict: "user_id,override_date" });
      if (error) return `Couldn't adjust that day: ${error.message}`;
      markMutated(ctx);
      const weeks = inp.weeks_from_now ? `(${inp.weeks_from_now} week${inp.weeks_from_now > 1 ? "s" : ""} out) ` : "";
      if (patch.closed) return `${inp.day} ${weeks}now has nothing scheduled — anything that was there has moved.`;
      return `${inp.day} ${weeks}updated.${inp.allow_weekend ? " That weekend day is now allowed for scheduling." : ""}${inp.off === false ? " It is open again, back to the hours it had." : ""}`;
    },
  });

  const record_progress = betaTool({
    name: "record_progress",
    description:
      "Log full, partial, or zero completion of a started or past time block. minutes_done less than the block length reschedules the remainder later in the week; 0 marks it missed (all rescheduled).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "title of the task or weekly-hours block" },
        minutes_done: { type: "number" },
        fully_done: { type: "boolean" },
      },
      required: ["title"],
    },
    run: async ({ title, minutes_done, fully_done }) => {
      const rows = await queryScheduleRows(supabase, userId);
      const { inputs } = buildScheduleInputs(rows);
      const schedule = computeSchedule(inputs);
      const n = title.toLowerCase();
      const candidates = schedule.blocks.filter(
        (b) =>
          b.type === "task" &&
          b.gday >= 0 && // history blocks are already logged; this is for the current week
          b.status &&
          (b.title.toLowerCase().includes(n) || n.includes(b.title.toLowerCase())),
      );
      if (!candidates.length) return `No started or past block matching "${title}" this week.`;
      candidates.sort((a, b) => (a.abs ?? 0) - (b.abs ?? 0));
      const c = candidates[candidates.length - 1];
      const len = c.end - c.start;
      const m = /^research-(.+)-w\d+$/.exec(c.taskId!);
      const subjectType = m ? "research" : "task";
      const subjectId = m ? m[1] : c.taskId!;
      const gdayDate = new Date(ctx.today);
      gdayDate.setDate(gdayDate.getDate() - ((gdayDate.getDay() + 6) % 7) + c.gday);
      const occurred_date = `${gdayDate.getFullYear()}-${String(gdayDate.getMonth() + 1).padStart(2, "0")}-${String(gdayDate.getDate()).padStart(2, "0")}`;

      if (fully_done || (minutes_done != null && minutes_done >= len)) {
        const failed = await writeError(
          `Couldn't log the "${c.title}" block`,
          supabase.from("progress_log").upsert(
            { user_id: userId, subject_type: subjectType, subject_id: subjectId, occurred_date, start_min: c.start, end_min: c.end, minutes_done: null },
            { onConflict: "user_id,subject_type,subject_id,occurred_date,start_min" },
          ),
        );
        if (failed) return failed;
        markMutated(ctx);
        return `Marked the "${c.title}" block (${len}m) done.`;
      }
      if (minutes_done == null) return `How much of the ${len}m block did you complete?`;
      if (minutes_done <= 0) {
        const failed = await writeError(
          `Couldn't mark the "${c.title}" block missed`,
          supabase
            .from("progress_log")
            .delete()
            .match({ user_id: userId, subject_type: subjectType, subject_id: subjectId, occurred_date, start_min: c.start }),
        );
        if (failed) return failed;
        markMutated(ctx);
        return `Marked the "${c.title}" block missed — all ${len}m rescheduled later this week.`;
      }
      const mins = Math.max(15, Math.round(minutes_done / 15) * 15);
      const partialFailed = await writeError(
        `Couldn't log time on "${c.title}"`,
        supabase.from("progress_log").upsert(
          {
            user_id: userId,
            subject_type: subjectType,
            subject_id: subjectId,
            occurred_date,
            start_min: c.start,
            end_min: c.end,
            minutes_done: Math.min(mins, len - 15),
          },
          { onConflict: "user_id,subject_type,subject_id,occurred_date,start_min" },
        ),
      );
      if (partialFailed) return partialFailed;
      markMutated(ctx);
      return `Logged ${mins}m of ${len}m on "${c.title}" — the remaining ${len - mins}m is rescheduled later this week.`;
    },
  });

  const pin_research = betaTool({
    name: "pin_research",
    description:
      'Fix a project\'s weekly hours to an exact slot — ALWAYS use this (never add_event) when the user says they are working on one of their projects now or at a specific time ("I am doing my main project right now for an hour", "put the analysis at 2pm tomorrow"). The block keeps its label and done-checkbox, its minutes count toward that project\'s weekly hours, and whatever was scheduled there reflows automatically. One pin per project per day — re-pinning the same day moves it.',
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "fuzzy title of the research project" },
        date: { type: "string", description: 'natural-language date, e.g. "today", "tomorrow", "monday". Defaults to today for "right now".' },
        time: {
          type: "string",
          description: 'clock time, e.g. "2pm", "14:30". Also accepts "right now"/"asap" and relative phrases like "in 30 minutes".',
        },
        length_min: { type: "number", description: "minutes to fix at that time (default 60)" },
        clear: { type: "boolean", description: "remove this project's pin on that date and let the engine place its research freely again" },
      },
      required: ["project"],
    },
    run: async (inp) => {
      // Archived is excluded outright; on hold is fetched so the refusal below
      // can name the reason. Pinning either wrote a research_pin the engine
      // then ignored — the hours are stripped for a hold and the commitment
      // isn't queried at all once archived — and reported success.
      const { data: projects } = await supabase
        .from("projects")
        .select("id,title,weekly_min_min,on_hold_at")
        .eq("user_id", userId)
        .is("archived_at", null);
      const { match, ambiguous } = findByTitle(projects ?? [], inp.project);
      if (ambiguous.length) {
        return `"${inp.project}" matches multiple projects: ${ambiguous.map((p) => p.title).join(", ")}. Say which one.`;
      }
      if (!match) return `No project matching "${inp.project}". Projects: ${(projects ?? []).map((p) => p.title).join(", ") || "none"}.`;
      if (match.on_hold_at) {
        return `"${match.title}" is on hold, so nothing is scheduled for it and a pinned slot would sit empty. Take it off hold first (add_trackable with on_hold=false) if you want to work on it.`;
      }

      if (inp.clear) {
        const pin = resolvePin(ctx, inp.date ?? "today", inp.time ?? "noon");
        if (typeof pin === "string") return `Couldn't clear the pin: ${pin}`;
        const failed = await writeError(
          `Couldn't clear the ${match.title} research time`,
          supabase
            .from("research_pins")
            .delete()
            .match({ user_id: userId, project_id: match.id, pinned_date: pin!.pinned_date }),
        );
        if (failed) return failed;
        markMutated(ctx);
        return `Cleared the fixed ${match.title} research time on ${pin!.pinned_date} — it auto-schedules freely again.`;
      }

      const pin = resolvePin(ctx, inp.date, inp.time);
      if (pin == null) return `Give a time for the ${match.title} research block, e.g. "right now" or "2pm today".`;
      if (typeof pin === "string") return `Couldn't pin ${match.title}: ${pin}`;
      const length = Math.max(15, Math.round((inp.length_min || 60) / 15) * 15);

      const conflict = await pinConflict(ctx, pin, length);
      if (conflict) return `Couldn't pin ${match.title}: ${conflict}`;

      const pinFailed = await writeError(
        `Couldn't pin ${match.title}`,
        supabase.from("research_pins").upsert(
          {
            user_id: userId,
            project_id: match.id,
            pinned_date: pin.pinned_date,
            start_min: pin.pinned_start_min,
            length_min: length,
          },
          { onConflict: "user_id,project_id,pinned_date" },
        ),
      );
      if (pinFailed) return pinFailed;
      markMutated(ctx);
      const notResearch = !match.weekly_min_min
        ? ` Note: ${match.title} has no weekly research minimum set, so this time is additive rather than filling a quota.`
        : "";
      return `${match.title} research is now fixed on ${pin.pinned_date} at ${minToLabel(pin.pinned_start_min)} for ${length}m — anything that was there reflows automatically, and those minutes count toward its weekly hours. Check it off from the calendar when you're done.${notResearch}`;
    },
  });

  const update_recurring = betaTool({
    name: "update_recurring",
    description:
      'Create, update, or remove a routine — a standing weekly slot (email, lunch, gym, lit scan...). Routines persist across sessions. Give a window for flexible placement, anytime=true for "wherever it fits", window_start with no window_end for a fixed time, or anchor="day_start"/"day_end" for one that holds an END of the working day rather than a clock time. A routine may carry a label, and most should not: a labelled one counts toward that label\'s weekly share and reduces what its commitments are asked for, which is right for a weekly literature scan and wrong for a standing email slot.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri"] } },
        length_min: { type: "number" },
        window_start: { type: "string", description: '"12pm", "9:00"' },
        window_end: { type: "string" },
        anytime: { type: "boolean", description: "place wherever it fits in the day" },
        anchor: {
          type: "string",
          enum: ["day_start", "day_end", "none"],
          description:
            'tie it to an end of the working day instead of a clock time: "day_start" = the first thing in the day (nothing else is scheduled before it), "day_end" = the last. Use this whenever the user describes a routine in terms of the start or end of their day ("emails first thing", "wrap up at the end of the day") rather than a time — it then follows their hours instead of going stale when those hours change. It may slide within its half of the day if a meeting is already on that edge, and is skipped for that day if it can\'t. "none" turns it back into an ordinary windowed routine.',
        },
        category: {
          type: "string",
          description:
            "name of the label this routine's time counts toward — use only when the routine IS that kind of work (a lit scan is research; email time is not). Pass \"none\" to remove a label already set.",
        },
        remove: { type: "boolean" },
      },
      required: ["title"],
    },
    run: async (inp) => {
      const weekdayMap: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4 };
      const { data: rules } = await supabase.from("recurring_rules").select("*").eq("user_id", userId);
      const match = fuzzyFindByTitle(rules ?? [], inp.title);

      if (inp.remove) {
        if (!match) return `No recurring rule matching "${inp.title}".`;
        const { error } = await supabase.from("recurring_rules").delete().eq("id", match.id);
        if (error) return `Couldn't remove "${match.title}": ${error.message}`;
        markMutated(ctx);
        return `Removed the recurring "${match.title}" rule.`;
      }

      const days = inp.days ? inp.days.map((d) => weekdayMap[d]).filter((d) => d != null) : (match?.days ?? [0, 1, 2, 3, 4]);
      const length_min = inp.length_min ?? match?.length_min ?? 30;
      let win_start_min = match?.win_start_min ?? null;
      let win_end_min = match?.win_end_min ?? null;
      let anchor: RoutineAnchor | null = match?.anchor ?? null;
      if (inp.anchor) anchor = inp.anchor === "none" ? null : (inp.anchor as RoutineAnchor);
      if (inp.anytime) {
        win_start_min = null;
        win_end_min = null;
        anchor = null;
      }
      // Whether a time was actually UNDERSTOOD, not merely supplied. The
      // difference decides whether the anchor is dropped below, and getting it
      // wrong un-anchored a routine on garbage input: "first thing in my day"
      // silently became "wherever it fits", with no window and no complaint.
      let gotTime = false;
      const unparsedTimes: string[] = [];
      if (inp.window_start != null) {
        const t = parseTimeStr(inp.window_start);
        if (t != null) {
          win_start_min = t;
          gotTime = true;
        } else unparsedTimes.push(`start time "${inp.window_start}"`);
      }
      if (inp.window_end != null) {
        const t = parseTimeStr(inp.window_end);
        if (t != null) {
          win_end_min = t;
          gotTime = true;
        } else unparsedTimes.push(`end time "${inp.window_end}"`);
      }
      if (win_start_min != null && win_end_min == null) win_end_min = win_start_min + length_min;
      // A time given in the same breath as an anchor is the more specific of the
      // two answers, so it wins and the anchor drops — the alternative is a row
      // the database rejects outright (migration 0039) for what reads as a
      // reasonable request. An anchor with no time simply clears the window.
      if (anchor && gotTime) anchor = null;
      if (anchor) {
        win_start_min = null;
        win_end_min = null;
      }

      // "none" erases, an omitted field leaves whatever is set — the same
      // three-way distinction add_trackable draws for its own facets.
      let category_id = match?.category_id ?? null;
      if (inp.category) {
        category_id = ["none", "no label", "clear", "remove", "unset"].includes(inp.category.trim().toLowerCase())
          ? null
          : ((await findCategoryId(ctx, inp.category)) ?? category_id);
      }

      const payload = { title: inp.title, tag: match?.tag ?? "anchor", days, length_min, win_start_min, win_end_min, anchor, category_id };
      // This reported "Saved permanently." without ever looking at whether it
      // had been — and the anchor/window constraint added in 0039 gives it a
      // real way to fail.
      const { error: writeErr } = match
        ? await supabase.from("recurring_rules").update(payload).eq("id", match.id)
        : await supabase.from("recurring_rules").insert({ user_id: userId, ...payload });
      if (writeErr) return `Couldn't save the "${inp.title}" routine: ${writeErr.message}`;
      markMutated(ctx);

      const win = anchor
        ? anchor === "day_start"
          ? "first thing in the day, whenever the day starts"
          : "last thing in the day"
        : win_start_min == null
          ? "wherever it fits"
          : `${win_start_min}-${win_end_min}`;
      const timeNote = unparsedTimes.length
        ? ` Couldn't understand the ${unparsedTimes.join(" or the ")}, so ${unparsedTimes.length > 1 ? "those were" : "that was"} ignored — try a format like "9:15" or "2pm".`
        : "";
      const labelNote = category_id
        ? " Its minutes count toward that label's weekly share, so the commitments wearing it are asked for the rest."
        : "";
      return `${match ? "Updated" : "Added"} standing rule — "${inp.title}": ${length_min}m, ${win}. Saved permanently.${timeNote}${labelNote}`;
    },
  });

  const set_week_reserve = betaTool({
    name: "set_week_reserve",
    description:
      'Set what a normal week is NOT available for, so feasibility is judged against the hours that really exist. Two figures, both in hours per week: `expected_meeting_hours` is the typical meeting load — only the part not yet on the calendar is held back, so it decays as real meetings land — and `unbooked_hours` is slack kept free for the unplanned, which always stands. Reach for this whenever the user describes their week in terms of what it can\'t take ("I need to keep 8-10 hours a week clear", "assume 10-15h of meetings"): a rule saved with remember_rule holds only while YOU are doing the booking, whereas these two numbers are read by the week view and by every pace sentence. Advisory even so — the scheduler still fills the week. Pass 0 to remove an assumption.',
    inputSchema: {
      type: "object",
      properties: {
        expected_meeting_hours: { type: "number", description: "typical meetings per week, in hours" },
        unbooked_hours: { type: "number", description: "hours per week kept free for the unplanned" },
      },
    },
    run: async (inp) => {
      const patch: { expected_meeting_min_per_week?: number; reserve_misc_min_per_week?: number } = {};
      // Omitted leaves whatever is set; 0 is a real value that clears one — the
      // same three-way distinction the other update tools draw.
      if (inp.expected_meeting_hours != null)
        patch.expected_meeting_min_per_week = Math.max(0, Math.round(inp.expected_meeting_hours * 60));
      if (inp.unbooked_hours != null) patch.reserve_misc_min_per_week = Math.max(0, Math.round(inp.unbooked_hours * 60));
      if (!Object.keys(patch).length) return "Nothing to change — give expected_meeting_hours, unbooked_hours, or both.";

      const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
      if (error) return `Couldn't save that: ${error.message}`;
      markMutated(ctx);

      const said = [
        patch.expected_meeting_min_per_week != null
          ? `${patch.expected_meeting_min_per_week / 60}h/wk of expected meetings`
          : null,
        patch.reserve_misc_min_per_week != null ? `${patch.reserve_misc_min_per_week / 60}h/wk kept unbooked` : null,
      ].filter(Boolean);
      return `Set: ${said.join(", ")}. The week view and every pace figure now measure against what's left after this; the scheduler itself still fills the week, so this makes the numbers honest rather than making the time untouchable.`;
    },
  });

  const remember_rule = betaTool({
    name: "remember_rule",
    description:
      'Save (or forget) a free-form standing rule you must always honour when scheduling and advising, e.g. "keep Friday afternoons free", "prefer 2h research chunks". These are instructions to YOU, not constraints on the engine — it never sees them. So if what the user wants can be enforced instead (standard hours, one day\'s hours, a routine, or a label\'s minimum chunk / time of day / share of the week), set that as well as, or instead of, saving a rule about it. The user can also read, reword and delete these in Settings → Standing rules, so expect them to have changed between turns.',
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" }, forget: { type: "boolean" } },
      required: ["note"],
    },
    run: async ({ note, forget }) => {
      if (forget) {
        const { data: notes } = await supabase.from("preference_notes").select("*").eq("user_id", userId);
        const needle = note.toLowerCase();
        const matches = (notes ?? []).filter(
          (x) => x.note.toLowerCase().includes(needle) || needle.includes(x.note.toLowerCase()),
        );
        if (!matches.length) return "No saved rule matches that.";
        // Substring matching in either direction, over rules that are whole
        // sentences: a phrase like "research" can easily hit several. Deleting
        // the first one silently is how the wrong rule disappears.
        if (matches.length > 1) {
          return (
            `That matches ${matches.length} saved rules, so I haven't deleted any. Say which one, using enough of its wording to be unambiguous:\n` +
            matches.map((m) => `  - "${m.note}"`).join("\n")
          );
        }
        const failed = await writeError(
          "Couldn't forget that rule",
          supabase.from("preference_notes").delete().eq("id", matches[0].id),
        );
        if (failed) return failed;
        markMutated(ctx);
        return `Forgot: "${matches[0].note}".`;
      }
      const failed = await writeError(
        "Couldn't save that rule",
        supabase.from("preference_notes").insert({ user_id: userId, note }),
      );
      if (failed) return failed;
      markMutated(ctx);
      return `Remembered: "${note}". I'll honor this from now on.`;
    },
  });

  const get_status = betaTool({
    name: "get_status",
    description: "Get deadline and weekly-hours status for a project by title, or omit title for a full overview.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    run: async ({ title }) => {
      const rows = await queryScheduleRows(supabase, userId);
      const { inputs } = buildScheduleInputs(rows);
      const schedule = computeSchedule(inputs);
      // inputs.projects already carries these, mapped once and correctly — the
      // hand-rolled copy this replaces parsed deadline_date as UTC and so
      // reported every deadline a day early.
      const trackables = inputs.projects;

      if (title) {
        const { match: found, ambiguous } = findByTitle(trackables, title);
        if (ambiguous.length) return ambiguousMsg("projects", title, ambiguous);
        if (!found) return `Nothing matching "${title}". Tracking: ${trackables.map((t) => t.title).join(", ") || "nothing"}.`;
        return statusReply(found, ctx.today, ctx.weeklyHours, inputs.tasks, schedule);
      }

      const parts = [
        trackables.map((t) => statusReply(t, ctx.today, ctx.weeklyHours, inputs.tasks, schedule)).join(" "),
        schedule.missed.length ? "Missed and rescheduled: " + schedule.missed.join(", ") + "." : "",
        schedule.risk.length ? "Will miss deadline: " + schedule.risk.join(", ") + "." : "",
        schedule.nearDeadline.length ? "Cutting it close (finishes the day it's due): " + schedule.nearDeadline.join(", ") + "." : "",
        schedule.overflow.length ? "Didn't fit this week: " + schedule.overflow.join(", ") + "." : "",
        schedule.beyondHorizon.length
          ? "Starts beyond the planning horizon, so not scheduled yet (not a capacity problem): " +
            schedule.beyondHorizon.join(", ") +
            "."
          : "",
      ].filter(Boolean);
      return parts.join(" ") || "All clear.";
    },
  });

  return [
    add_task,
    update_task,
    remove_item,
    add_trackable,
    add_target,
    plan_phases,
    complete_target,
    add_event,
    adjust_day_hours,
    record_progress,
    pin_research,
    update_recurring,
    set_week_reserve,
    remember_rule,
    get_status,
  ];
}

// Re-exported for the API route's task-def usage without a circular import.
export type { Task };
