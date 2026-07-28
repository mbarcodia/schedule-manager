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
import { gdayForDate, minToLabel, zonedTimeToUtc, zonedNow } from "@/lib/scheduling/time";
import { computeSchedule } from "@/lib/scheduling/engine";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
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

function titleToDeadlineAt(ctx: ToolContext, dueLower: string): string | null {
  const d = parseDeadlineDate(dueLower, ctx.today);
  if (!d) return null;
  // Honour an explicit clock time ("due by 2pm November 10"); 5pm otherwise,
  // which is the sane default for "due Friday" with no time given.
  const minute = parseTimeInText(dueLower);
  const hour = minute != null ? Math.floor(minute / 60) : 17;
  const min = minute != null ? minute % 60 : 0;
  return zonedTimeToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), hour, min, ctx.timezone).toISOString();
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
  | { status: "found"; projectId: string | null; proposalId: string | null; title: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" };

/** Resolves a project/proposal by title. Both kinds are scored together
 * (not project-then-proposal in sequence) so a same-titled project and
 * proposal are correctly flagged ambiguous instead of the project silently
 * winning by search order. */
export async function findTrackableId(ctx: ToolContext, needle: string): Promise<TrackableLookup> {
  const [{ data: projects }, { data: proposals }] = await Promise.all([
    ctx.supabase.from("projects").select("id,title").eq("user_id", ctx.userId),
    ctx.supabase.from("proposals").select("id,title").eq("user_id", ctx.userId),
  ]);
  const combined = [
    ...(projects ?? []).map((p) => ({ id: p.id, title: p.title, isProject: true })),
    ...(proposals ?? []).map((p) => ({ id: p.id, title: p.title, isProject: false })),
  ];
  const { match, ambiguous } = findByTitle(combined, needle);
  if (ambiguous.length) return { status: "ambiguous", candidates: ambiguous.map((c) => c.title) };
  if (!match) return { status: "none" };
  console.log(`[assistant] trackable resolved: needle=${JSON.stringify(needle)} -> id=${match.id} title=${JSON.stringify(match.title)}`);
  return match.isProject
    ? { status: "found", projectId: match.id, proposalId: null, title: match.title }
    : { status: "found", projectId: null, proposalId: match.id, title: match.title };
}

function ambiguousMsg(kind: string, needle: string, candidates: { title: string }[]): string {
  return `"${needle}" matches multiple ${kind}: ${candidates.map((c) => c.title).join(", ")}. Say which one (use its exact title).`;
}

/** Fuzzy-matches a category by name (case-insensitive substring, either
 * direction) — returns null silently if no match; callers just omit
 * category_id rather than failing the whole tool call over it. */
async function findCategoryId(ctx: ToolContext, needle: string): Promise<string | null> {
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
  if (gday < 0 || gday >= ctx.horizonWeeks * 7) return `That date is outside the ${ctx.horizonWeeks}-week scheduling horizon.`;
  const pinned_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { pinned_date, pinned_start_min: start };
}

/** A pin can't land on top of a real fixed event — that's the one thing the
 * engine can never bump. Everything else (other tasks/research) is fine to
 * displace. */
async function pinConflict(ctx: ToolContext, pin: ResolvedPin, lengthMin: number): Promise<string | null> {
  const { data: events } = await ctx.supabase.from("events").select("title,starts_at,ends_at").eq("user_id", ctx.userId);
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
    description: "Add a task to the schedule. It is auto-placed by priority, deadline, and the morning rules.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        duration_min: { type: "number", description: "total minutes, default 30" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        chunk_min: { type: "number", description: "split into chunks of this many minutes" },
        max_per_day_min: { type: "number", description: "spread the work: schedule at most this many minutes of it per day" },
        deep_focus: { type: "boolean", description: "restrict to mornings before noon" },
        time_of_day: {
          type: "string",
          enum: ["morning", "afternoon"],
          description:
            'Use whenever the user names a general part of the day without an exact clock time (e.g. "schedule this in the afternoon"). "morning" = before noon, "afternoon" = noon or later. For an exact time instead, use pin_date/pin_time.',
        },
        due: {
          type: "string",
          description:
            'Deadline in natural language, e.g. "july 24", "friday", "in 2 weeks". A clock time is honoured when given ("2pm november 10", "friday at noon"); with no time it lands at 5pm that day.',
        },
        not_before: {
          type: "string",
          description:
            'EARLIEST date this may be scheduled ("tomorrow", "monday", "november 9"). Use whenever the user says when work should START, not when it is due — "tomorrow morning" means not_before="tomorrow" WITH time_of_day="morning". Omitting it lets the engine place the work today.',
        },
        project: { type: "string", description: "title of project/proposal to link to" },
        category: { type: "string", description: "name of the category to color this task by (e.g. Research, Teaching, Tasks) — omit to leave uncategorized" },
        pin_date: { type: "string", description: 'force part of this task onto an exact date, natural language, e.g. "monday", "july 24" — pairs with pin_time. Anything else scheduled there moves automatically; the rest of this task (if any) is still auto-placed.' },
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

      let link: { projectId: string | null; proposalId: string | null; title: string } | null = null;
      if (inp.project) {
        const lookup = await findTrackableId(ctx, inp.project);
        if (lookup.status === "ambiguous") {
          return `"${inp.project}" matches multiple projects/proposals: ${lookup.candidates.join(", ")}. Say which one (use its exact title), or add the task without a project link.`;
        }
        if (lookup.status === "none") {
          return `No project or proposal matching "${inp.project}" — add it first, or add the task without a project link.`;
        }
        link = { projectId: lookup.projectId, proposalId: lookup.proposalId, title: lookup.title };
      }

      const categoryId = inp.category ? await findCategoryId(ctx, inp.category) : null;
      const deadline_at = inp.due ? titleToDeadlineAt(ctx, inp.due.toLowerCase()) : null;
      const deadlineNotUnderstood = !!inp.due && !deadline_at;
      const notBeforeAt = inp.not_before ? titleToFloorAt(ctx, inp.not_before.toLowerCase()) : null;
      const notBeforeNotUnderstood = !!inp.not_before && !notBeforeAt;
      const priority = inp.priority || "medium";
      const chunk_min = inp.chunk_min || (duration > 90 ? 60 : duration);

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
        tag: inp.deep_focus ? "deep-focus" : null,
        time_of_day: inp.time_of_day ?? null,
        deadline_at,
        floor_at: notBeforeAt ?? new Date().toISOString(),
        max_per_day_min: inp.max_per_day_min || null,
        project_id: link?.projectId ?? null,
        proposal_id: link?.proposalId ?? null,
        category_id: categoryId,
        pinned_date: pin?.pinned_date ?? null,
        pinned_start_min: pin?.pinned_start_min ?? null,
        pinned_length_min: pinLength,
      };
      const summary = `(${duration}m, ${priority} priority${link ? ", linked to " + link.title : ""}).${pin ? ` ${pinLength}m pinned to ${inp.pin_date} at ${inp.pin_time} — anything else scheduled there moves automatically.` : inp.time_of_day ? ` Placed in the ${inp.time_of_day}.` : " Placed on the calendar."}${deadlineNotUnderstood ? ` Couldn't understand the deadline "${inp.due}", so no deadline was set — try a format like "july 24" or "in 2 weeks".` : ""}${notBeforeNotUnderstood ? ` Couldn't understand the start date "${inp.not_before}", so it may be scheduled as early as today.` : notBeforeAt ? ` Not scheduled before ${inp.not_before}.` : ""}`;

      // Dedupe on exact (normalized) title — re-declaring a task with the
      // same title updates it in place instead of creating a duplicate.
      const { data: existingTasks } = await supabase.from("tasks").select("id,title").eq("user_id", userId);
      const dupe = (existingTasks ?? []).find((t) => normTitle(t.title) === normTitle(inp.title));
      if (dupe) {
        const { error } = await supabase.from("tasks").update(payload).eq("id", dupe.id);
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
        due: {
          type: "string",
          description:
            "new deadline, natural language; a clock time is honoured when given (else 5pm that day)",
        },
        not_before: {
          type: "string",
          description:
            'earliest date this may be scheduled ("tomorrow", "monday", "november 9") — use for "start it tomorrow" style requests, which a deadline alone cannot express',
        },
        category: { type: "string", description: "name of the category to recolor this task by" },
        time_of_day: {
          type: "string",
          enum: ["morning", "afternoon", "none"],
          description:
            'Use whenever the user names a general part of the day without an exact clock time. "morning" = before noon, "afternoon" = noon or later, "none" clears any existing constraint.',
        },
        work_on_next: { type: "boolean", description: "schedule this task at the next available time, before other flexible tasks" },
        important: {
          type: "boolean",
          description:
            "mark (true) or unmark (false) this task as important — the Eisenhower flag on the planning board. Independent of priority, which controls scheduling order.",
        },
        pin_date: { type: "string", description: 'force part of this task onto an exact date, natural language, e.g. "monday", "july 24" — pairs with pin_time. Anything else scheduled there moves automatically; the rest of the task (if any) is still auto-placed.' },
        pin_time: {
          type: "string",
          description:
            'clock time for pin_date, e.g. "2pm", "14:30", "noon", "midnight". Also accepts "right now"/"asap"/"immediately" (starts the next minute) and relative phrases like "in 30 minutes"/"in 2 hours"/"in an hour" — for any of these, pin_date can be omitted and defaults to today.',
        },
        pin_length_min: { type: "number", description: "minutes to pin at that exact time (default: the task's chunk size)" },
        clear_pin: { type: "boolean", description: "remove any pinned time and let this task auto-schedule freely again" },
      },
      required: ["title"],
    },
    run: async (inp) => {
      const { data: tasks } = await supabase.from("tasks").select("id,title,chunk_min,duration_min").eq("user_id", userId);
      const { match, ambiguous } = findByTitle(tasks ?? [], inp.title);
      if (ambiguous.length) {
        return `"${inp.title}" matches multiple tasks: ${ambiguous.map((t) => t.title).join(", ")}. Say which one (use its exact title).`;
      }
      if (!match) return `No task matching "${inp.title}". Tasks: ${(tasks ?? []).map((t) => t.title).join(", ") || "none"}.`;
      console.log(`[assistant] update_task resolved: needle=${JSON.stringify(inp.title)} -> id=${match.id} title=${JSON.stringify(match.title)}`);

      const patch: Database["public"]["Tables"]["tasks"]["Update"] = {};
      if (inp.priority) patch.priority = inp.priority;
      if (inp.duration_min) patch.duration_min = inp.duration_min;
      if (inp.chunk_min) patch.chunk_min = inp.chunk_min;
      if (inp.max_per_day_min != null) patch.max_per_day_min = inp.max_per_day_min || null;
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
        const deadline_at = titleToDeadlineAt(ctx, inp.due.toLowerCase());
        // Fail loudly rather than silently no-op-ing: an unparseable date
        // must not look identical to a successful update to the caller.
        if (!deadline_at) {
          return `Couldn't understand the deadline "${inp.due}" — try a format like "july 24", "friday", or "in 2 weeks". Nothing was changed.`;
        }
        patch.deadline_at = deadline_at;
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

  const remove_item = betaTool({
    name: "remove_item",
    description:
      "Remove a task, project, proposal, or goal by title. Removing a task clears its calendar blocks; removing a project also removes its research blocks and linked tasks stay but unlink.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }) => {
      const [{ data: tasks }, { data: proposals }, { data: goals }, { data: projects }, { data: events }] =
        await Promise.all([
          supabase.from("tasks").select("id,title").eq("user_id", userId),
          supabase.from("proposals").select("id,title").eq("user_id", userId),
          supabase.from("goals").select("id,title").eq("user_id", userId),
          supabase.from("projects").select("id,title").eq("user_id", userId),
          supabase.from("events").select("id,title").eq("user_id", userId),
        ]);

      const tMatch = findByTitle(tasks ?? [], title);
      if (tMatch.ambiguous.length) return ambiguousMsg("tasks", title, tMatch.ambiguous);
      const t = tMatch.match;
      if (t) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> task id=${t.id} title=${JSON.stringify(t.title)}`);
        await Promise.all([
          supabase.from("progress_log").delete().match({ user_id: userId, subject_type: "task", subject_id: t.id }),
          supabase.from("pinned_chunks").delete().match({ user_id: userId, subject_type: "task", subject_id: t.id }),
        ]);
        const { data: deleted, error } = await supabase.from("tasks").delete().eq("id", t.id).select("id");
        if (error) return `Couldn't remove "${t.title}": ${error.message}`;
        if (!deleted || deleted.length === 0) return `Couldn't remove "${t.title}" — nothing was deleted, try again.`;
        markMutated(ctx);
        return `Removed task "${t.title}" and its calendar blocks.`;
      }
      const pMatch = findByTitle(proposals ?? [], title);
      if (pMatch.ambiguous.length) return ambiguousMsg("proposals", title, pMatch.ambiguous);
      const p = pMatch.match;
      if (p) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> proposal id=${p.id} title=${JSON.stringify(p.title)}`);
        const { data: deleted, error } = await supabase.from("proposals").delete().eq("id", p.id).select("id");
        if (error) return `Couldn't remove "${p.title}": ${error.message}`;
        if (!deleted || deleted.length === 0) return `Couldn't remove "${p.title}" — nothing was deleted, try again.`;
        markMutated(ctx);
        return `Removed proposal "${p.title}".`;
      }
      const gMatch = findByTitle(goals ?? [], title);
      if (gMatch.ambiguous.length) return ambiguousMsg("goals", title, gMatch.ambiguous);
      const g = gMatch.match;
      if (g) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> goal id=${g.id} title=${JSON.stringify(g.title)}`);
        const { data: deleted, error } = await supabase.from("goals").delete().eq("id", g.id).select("id");
        if (error) return `Couldn't remove "${g.title}": ${error.message}`;
        if (!deleted || deleted.length === 0) return `Couldn't remove "${g.title}" — nothing was deleted, try again.`;
        markMutated(ctx);
        return `Removed goal "${g.title}".`;
      }
      const prMatch = findByTitle(projects ?? [], title);
      if (prMatch.ambiguous.length) return ambiguousMsg("projects", title, prMatch.ambiguous);
      const pr = prMatch.match;
      if (pr) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> project id=${pr.id} title=${JSON.stringify(pr.title)}`);
        await Promise.all([
          supabase.from("progress_log").delete().match({ user_id: userId, subject_type: "research", subject_id: pr.id }),
          supabase.from("pinned_chunks").delete().match({ user_id: userId, subject_type: "research", subject_id: pr.id }),
          supabase.from("tasks").update({ project_id: null }).eq("project_id", pr.id),
        ]);
        const { data: deleted, error } = await supabase.from("projects").delete().eq("id", pr.id).select("id");
        if (error) return `Couldn't remove "${pr.title}": ${error.message}`;
        if (!deleted || deleted.length === 0) return `Couldn't remove "${pr.title}" — nothing was deleted, try again.`;
        markMutated(ctx);
        return `Removed project "${pr.title}" and its weekly research blocks.`;
      }
      const evMatch = findByTitle(events ?? [], title);
      if (evMatch.ambiguous.length) return ambiguousMsg("events", title, evMatch.ambiguous);
      const ev = evMatch.match;
      if (ev) {
        console.log(`[assistant] remove_item resolved: needle=${JSON.stringify(title)} -> event id=${ev.id} title=${JSON.stringify(ev.title)}`);
        const { data: deleted, error } = await supabase.from("events").delete().eq("id", ev.id).select("id");
        if (error) return `Couldn't remove "${ev.title}": ${error.message}`;
        if (!deleted || deleted.length === 0) return `Couldn't remove "${ev.title}" — nothing was deleted, try again.`;
        markMutated(ctx);
        return `Removed event "${ev.title}" — the freed time refills automatically.`;
      }
      const all = [...(tasks ?? []), ...(proposals ?? []), ...(goals ?? []), ...(projects ?? [])];
      return `Nothing matching "${title}" found. Current items: ${all.map((x) => x.title).join(", ") || "none"}.`;
    },
  });

  const add_trackable = betaTool({
    name: "add_trackable",
    description:
      "Add a project (tracked toward a deadline, can carry a weekly research minimum), proposal (deadline-tracked), or goal (no deadline).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["project", "proposal", "goal"] },
        title: { type: "string" },
        due: { type: "string", description: 'natural language, e.g. "friday", "aug 3", "in 2 weeks"' },
        weekly_research_hrs: { type: "number", description: "projects only: weekly research minimum in hours" },
        cadence: { type: "string", description: "goals only: e.g. Daily, Weekly" },
        category: { type: "string", description: "projects only: name of the category to color this project's research chunks by" },
      },
      required: ["kind", "title"],
    },
    run: async (inp) => {
      const deadlineDate = inp.due ? parseDeadlineDate(inp.due.toLowerCase(), ctx.today) : null;
      const deadline_date = deadlineDate
        ? `${deadlineDate.getFullYear()}-${String(deadlineDate.getMonth() + 1).padStart(2, "0")}-${String(deadlineDate.getDate()).padStart(2, "0")}`
        : null;
      const deadlineNote =
        inp.due && !deadlineDate
          ? ` Couldn't understand the deadline "${inp.due}", so no deadline was set — try a format like "friday" or "aug 3".`
          : "";

      // Dedupe on exact (normalized) title within the same kind —
      // re-declaring a project/proposal/goal that already exists updates it
      // in place instead of creating a duplicate.
      if (inp.kind === "project") {
        const categoryId = inp.category ? await findCategoryId(ctx, inp.category) : null;
        const { data: existing } = await supabase.from("projects").select("id,title").eq("user_id", userId);
        const dupe = (existing ?? []).find((p) => normTitle(p.title) === normTitle(inp.title));
        const patch: Database["public"]["Tables"]["projects"]["Update"] = { title: inp.title };
        if (deadline_date) patch.deadline_date = deadline_date;
        if (inp.weekly_research_hrs != null) {
          patch.weekly_min_min = inp.weekly_research_hrs * 60;
          patch.prefer_morning = true;
        }
        if (categoryId) patch.category_id = categoryId;
        const summary = `${deadline_date ? ", due " + deadline_date : ""}${inp.weekly_research_hrs ? ", " + inp.weekly_research_hrs + "h/wk research minimum scheduled" : ""}.${deadlineNote}`;
        if (dupe) {
          const { error } = await supabase.from("projects").update(patch).eq("id", dupe.id);
          if (error) return `Couldn't update project: ${error.message}`;
          markMutated(ctx);
          console.log(`[assistant] add_trackable upsert: project id=${dupe.id} title=${JSON.stringify(dupe.title)}`);
          return `Project "${dupe.title}" already existed — updated it instead of creating a duplicate${summary}`;
        }
        const { data: inserted, error } = await supabase
          .from("projects")
          .insert({
            user_id: userId,
            title: inp.title,
            deadline_date,
            weekly_min_min: inp.weekly_research_hrs ? inp.weekly_research_hrs * 60 : null,
            prefer_morning: !!inp.weekly_research_hrs,
            chunk_min: 120,
            research_ord: 5,
            category_id: categoryId,
          })
          .select("id")
          .single();
        if (error) return `Couldn't add project: ${error.message}`;
        markMutated(ctx);
        console.log(`[assistant] add_trackable insert: project id=${inserted?.id} title=${JSON.stringify(inp.title)}`);
        return `Project "${inp.title}" added${summary}`;
      }
      if (inp.kind === "proposal") {
        const { data: existing } = await supabase.from("proposals").select("id,title").eq("user_id", userId);
        const dupe = (existing ?? []).find((p) => normTitle(p.title) === normTitle(inp.title));
        const summary = `${deadline_date ? ", due " + deadline_date : ""}.${deadlineNote}`;
        if (dupe) {
          const patch: Database["public"]["Tables"]["proposals"]["Update"] = { title: inp.title };
          if (deadline_date) patch.deadline_date = deadline_date;
          const { error } = await supabase.from("proposals").update(patch).eq("id", dupe.id);
          if (error) return `Couldn't update proposal: ${error.message}`;
          markMutated(ctx);
          console.log(`[assistant] add_trackable upsert: proposal id=${dupe.id} title=${JSON.stringify(dupe.title)}`);
          return `Proposal "${dupe.title}" already existed — updated it instead of creating a duplicate${summary}`;
        }
        const { data: inserted, error } = await supabase
          .from("proposals")
          .insert({ user_id: userId, title: inp.title, deadline_date })
          .select("id")
          .single();
        if (error) return `Couldn't add proposal: ${error.message}`;
        markMutated(ctx);
        console.log(`[assistant] add_trackable insert: proposal id=${inserted?.id} title=${JSON.stringify(inp.title)}`);
        return `Proposal "${inp.title}" added${summary}`;
      }
      const { data: existingGoals } = await supabase.from("goals").select("id,title").eq("user_id", userId);
      const dupeGoal = (existingGoals ?? []).find((g) => normTitle(g.title) === normTitle(inp.title));
      if (dupeGoal) {
        const { error } = await supabase
          .from("goals")
          .update({ title: inp.title, cadence: inp.cadence || undefined })
          .eq("id", dupeGoal.id);
        if (error) return `Couldn't update goal: ${error.message}`;
        markMutated(ctx);
        console.log(`[assistant] add_trackable upsert: goal id=${dupeGoal.id} title=${JSON.stringify(dupeGoal.title)}`);
        return `Goal "${dupeGoal.title}" already existed — updated it instead of creating a duplicate.`;
      }
      const { data: insertedGoal, error } = await supabase
        .from("goals")
        .insert({ user_id: userId, title: inp.title, cadence: inp.cadence || "Ongoing" })
        .select("id")
        .single();
      if (error) return `Couldn't add goal: ${error.message}`;
      markMutated(ctx);
      console.log(`[assistant] add_trackable insert: goal id=${insertedGoal?.id} title=${JSON.stringify(inp.title)}`);
      return `Goal "${inp.title}" added.`;
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
      if (gday < 0 || gday >= ctx.horizonWeeks * 7) return `That date is outside the ${ctx.horizonWeeks}-week scheduling horizon.`;

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
    description: "Shorten a day: set a later start or earlier end. Displaced work reschedules automatically.",
    inputSchema: {
      type: "object",
      properties: {
        day: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
        weeks_from_now: { type: "number", description: "0 = this week (default), 1 = next week, ..." },
        start_hour: { type: "number", description: "24h clock, e.g. 11" },
        end_hour: { type: "number", description: "24h clock, e.g. 15" },
        allow_weekend: { type: "boolean", description: "explicitly allow scheduling on this Saturday/Sunday" },
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

      const patch = {
        user_id: userId,
        override_date,
        start_min: inp.start_hour != null ? inp.start_hour * 60 : (existing?.start_min ?? null),
        end_min: inp.end_hour != null ? inp.end_hour * 60 : (existing?.end_min ?? null),
        allow_weekend: inp.allow_weekend ?? existing?.allow_weekend ?? false,
      };
      const { error } = await supabase
        .from("day_overrides")
        .upsert(patch, { onConflict: "user_id,override_date" });
      if (error) return `Couldn't adjust that day: ${error.message}`;
      markMutated(ctx);
      return `${inp.day} ${inp.weeks_from_now ? `(${inp.weeks_from_now} week${inp.weeks_from_now > 1 ? "s" : ""} out) ` : ""}updated.${inp.allow_weekend ? " That weekend day is now allowed for scheduling." : ""}`;
    },
  });

  const record_progress = betaTool({
    name: "record_progress",
    description:
      "Log full, partial, or zero completion of a started/past scheduled block. minutes_done less than the block length reschedules the remainder later in the week; 0 marks it missed (all rescheduled).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "task or research block title" },
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
        (b) => b.type === "task" && b.status && (b.title.toLowerCase().includes(n) || n.includes(b.title.toLowerCase())),
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
        await supabase.from("progress_log").upsert(
          { user_id: userId, subject_type: subjectType, subject_id: subjectId, occurred_date, start_min: c.start, end_min: c.end, minutes_done: null },
          { onConflict: "user_id,subject_type,subject_id,occurred_date,start_min" },
        );
        markMutated(ctx);
        return `Marked the "${c.title}" block (${len}m) done.`;
      }
      if (minutes_done == null) return `How much of the ${len}m block did you complete?`;
      if (minutes_done <= 0) {
        await supabase
          .from("progress_log")
          .delete()
          .match({ user_id: userId, subject_type: subjectType, subject_id: subjectId, occurred_date, start_min: c.start });
        markMutated(ctx);
        return `Marked the "${c.title}" block missed — all ${len}m rescheduled later this week.`;
      }
      const mins = Math.max(15, Math.round(minutes_done / 15) * 15);
      await supabase.from("progress_log").upsert(
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
      );
      markMutated(ctx);
      return `Logged ${mins}m of ${len}m on "${c.title}" — the remaining ${len - mins}m is rescheduled later this week.`;
    },
  });

  const pin_research = betaTool({
    name: "pin_research",
    description:
      'Fix a research project\'s time to an exact slot — ALWAYS use this (never add_event) when the user says they\'re working on a research project now or at a specific time ("I\'m doing ACE2-S2S right now for an hour", "put temp_thresh at 2pm tomorrow"). The block keeps its Research category and done-checkbox, its minutes count toward that project\'s weekly hours, and whatever was scheduled there reflows automatically. One pin per project per day — re-pinning the same day moves it.',
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
      const { data: projects } = await supabase
        .from("projects")
        .select("id,title,weekly_min_min")
        .eq("user_id", userId);
      const { match, ambiguous } = findByTitle(projects ?? [], inp.project);
      if (ambiguous.length) {
        return `"${inp.project}" matches multiple projects: ${ambiguous.map((p) => p.title).join(", ")}. Say which one.`;
      }
      if (!match) return `No project matching "${inp.project}". Projects: ${(projects ?? []).map((p) => p.title).join(", ") || "none"}.`;

      if (inp.clear) {
        const pin = resolvePin(ctx, inp.date ?? "today", inp.time ?? "noon");
        if (typeof pin === "string") return `Couldn't clear the pin: ${pin}`;
        await supabase
          .from("research_pins")
          .delete()
          .match({ user_id: userId, project_id: match.id, pinned_date: pin!.pinned_date });
        markMutated(ctx);
        return `Cleared the fixed ${match.title} research time on ${pin!.pinned_date} — it auto-schedules freely again.`;
      }

      const pin = resolvePin(ctx, inp.date, inp.time);
      if (pin == null) return `Give a time for the ${match.title} research block, e.g. "right now" or "2pm today".`;
      if (typeof pin === "string") return `Couldn't pin ${match.title}: ${pin}`;
      const length = Math.max(15, Math.round((inp.length_min || 60) / 15) * 15);

      const conflict = await pinConflict(ctx, pin, length);
      if (conflict) return `Couldn't pin ${match.title}: ${conflict}`;

      await supabase.from("research_pins").upsert(
        {
          user_id: userId,
          project_id: match.id,
          pinned_date: pin.pinned_date,
          start_min: pin.pinned_start_min,
          length_min: length,
        },
        { onConflict: "user_id,project_id,pinned_date" },
      );
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
      'Create, update, or remove a standing recurring-block rule (email, lunch, gym, lit scan...). Rules persist across sessions. Give a window for flexible placement, anytime=true for "wherever it fits", or window_start with no window_end for a fixed time.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri"] } },
        length_min: { type: "number" },
        window_start: { type: "string", description: '"12pm", "9:00"' },
        window_end: { type: "string" },
        anytime: { type: "boolean", description: "place wherever it fits in the day" },
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
        await supabase.from("recurring_rules").delete().eq("id", match.id);
        markMutated(ctx);
        return `Removed the recurring "${match.title}" rule.`;
      }

      const days = inp.days ? inp.days.map((d) => weekdayMap[d]).filter((d) => d != null) : (match?.days ?? [0, 1, 2, 3, 4]);
      const length_min = inp.length_min ?? match?.length_min ?? 30;
      let win_start_min = match?.win_start_min ?? null;
      let win_end_min = match?.win_end_min ?? null;
      if (inp.anytime) {
        win_start_min = null;
        win_end_min = null;
      }
      if (inp.window_start != null) {
        const t = parseTimeStr(inp.window_start);
        if (t != null) win_start_min = t;
      }
      if (inp.window_end != null) {
        const t = parseTimeStr(inp.window_end);
        if (t != null) win_end_min = t;
      }
      if (win_start_min != null && win_end_min == null) win_end_min = win_start_min + length_min;

      const payload = { title: inp.title, tag: match?.tag ?? "anchor", days, length_min, win_start_min, win_end_min };
      if (match) await supabase.from("recurring_rules").update(payload).eq("id", match.id);
      else await supabase.from("recurring_rules").insert({ user_id: userId, ...payload });
      markMutated(ctx);

      const win = win_start_min == null ? "wherever it fits" : `${win_start_min}-${win_end_min}`;
      return `${match ? "Updated" : "Added"} standing rule — "${inp.title}": ${length_min}m, ${win}. Saved permanently.`;
    },
  });

  const remember_rule = betaTool({
    name: "remember_rule",
    description:
      'Save (or forget) a free-form standing preference the assistant must always honor when scheduling and advising, e.g. "keep Friday afternoons free", "prefer 2h research chunks".',
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" }, forget: { type: "boolean" } },
      required: ["note"],
    },
    run: async ({ note, forget }) => {
      if (forget) {
        const { data: notes } = await supabase.from("preference_notes").select("*").eq("user_id", userId);
        const match = (notes ?? []).find(
          (x) => x.note.toLowerCase().includes(note.toLowerCase()) || note.toLowerCase().includes(x.note.toLowerCase()),
        );
        if (!match) return "No saved preference matches that.";
        await supabase.from("preference_notes").delete().eq("id", match.id);
        markMutated(ctx);
        return `Forgot: "${match.note}".`;
      }
      await supabase.from("preference_notes").insert({ user_id: userId, note });
      markMutated(ctx);
      return `Remembered: "${note}". I'll honor this from now on.`;
    },
  });

  const get_status = betaTool({
    name: "get_status",
    description: "Get deadline/research status for a project or proposal by title, or omit title for a full overview.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    run: async ({ title }) => {
      const rows = await queryScheduleRows(supabase, userId);
      const { inputs } = buildScheduleInputs(rows);
      const schedule = computeSchedule(inputs);
      const trackables = [
        ...rows.projects.map((p) => ({
          id: p.id,
          title: p.title,
          deadlineDate: p.deadline_date ? new Date(p.deadline_date) : null,
          weeklyMinMin: p.weekly_min_min,
          preferMorning: p.prefer_morning,
        })),
        ...rows.proposals.map((p) => ({ id: p.id, title: p.title, deadlineDate: p.deadline_date ? new Date(p.deadline_date) : null })),
      ];

      if (title) {
        const { match: found, ambiguous } = findByTitle(trackables, title);
        if (ambiguous.length) return ambiguousMsg("projects/proposals", title, ambiguous);
        if (!found) return `Nothing matching "${title}". Tracking: ${trackables.map((t) => t.title).join(", ") || "nothing"}.`;
        return statusReply(found, ctx.today, ctx.weeklyHours, inputs.tasks, schedule);
      }

      const parts = [
        trackables.map((t) => statusReply(t, ctx.today, ctx.weeklyHours, inputs.tasks, schedule)).join(" "),
        schedule.missed.length ? "Missed and rescheduled: " + schedule.missed.join(", ") + "." : "",
        schedule.risk.length ? "Will miss deadline: " + schedule.risk.join(", ") + "." : "",
        schedule.nearDeadline.length ? "Cutting it close (finishes the day it's due): " + schedule.nearDeadline.join(", ") + "." : "",
        schedule.overflow.length ? "Didn't fit this week: " + schedule.overflow.join(", ") + "." : "",
      ].filter(Boolean);
      return parts.join(" ") || "All clear.";
    },
  });

  return [
    add_task,
    update_task,
    remove_item,
    add_trackable,
    add_event,
    adjust_day_hours,
    record_progress,
    pin_research,
    update_recurring,
    remember_rule,
    get_status,
  ];
}

// Re-exported for the API route's task-def usage without a circular import.
export type { Task };
