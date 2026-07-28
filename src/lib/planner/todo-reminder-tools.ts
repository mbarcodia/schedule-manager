// Chat tools for the two unscheduled kinds of thing: to-do items and
// reminders. Kept in their own file (and named unmistakably) because the whole
// point is that the model must not confuse them with Work:
//
//   add_task      -> hours the engine schedules on the calendar
//   add_todo      -> a line on a named checklist, no hours, never scheduled
//   add_reminder  -> a dated nudge that arrives as a push notification
//
// "Add write email to Rich to THIS WEEK" is a to-do. "Remind me a week before
// the IDSC seminar" is a reminder. "Block 3 hours to prepare it" is Work.

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { markMutated, type ToolContext } from "@/lib/assistant/tools";
import { parseDeadlineDate, parseTimeInText, findByTitle } from "@/lib/assistant/nlp-dates";
import { zonedTimeToUtc } from "@/lib/scheduling/time";

/** Named lead times so the model doesn't have to do minute arithmetic. */
const LEAD_PHRASES: { pattern: RegExp; minutes: number }[] = [
  { pattern: /\b(\d+)\s*week/i, minutes: 7 * 24 * 60 },
  { pattern: /\b(\d+)\s*day/i, minutes: 24 * 60 },
  { pattern: /\b(\d+)\s*hour/i, minutes: 60 },
  { pattern: /\bmonth/i, minutes: 30 * 24 * 60 },
];

/** "1 week before, 1 day before" -> [10080, 1440]. Accepts a list in one
 * string because that's how people say it. */
export function parseLeadMinutes(raw: string | undefined): number[] {
  if (!raw) return [24 * 60];
  const parts = raw.split(/,|\band\b|;/);
  const out: number[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    if (/\b(on the day|same day|day of|at the time|when it happens)\b/i.test(text)) {
      out.push(0);
      continue;
    }
    for (const { pattern, minutes } of LEAD_PHRASES) {
      const m = text.match(pattern);
      if (m) {
        const n = m[1] ? parseInt(m[1], 10) : 1;
        out.push(n * minutes);
        break;
      }
    }
  }
  // Longest lead first, de-duplicated.
  return out.length ? Array.from(new Set(out)).sort((a, b) => b - a) : [24 * 60];
}

function describeLead(minutes: number): string {
  if (minutes === 0) return "at the time";
  if (minutes % (7 * 24 * 60) === 0) {
    const w = minutes / (7 * 24 * 60);
    return `${w} week${w > 1 ? "s" : ""} before`;
  }
  if (minutes % (24 * 60) === 0) {
    const d = minutes / (24 * 60);
    return `${d} day${d > 1 ? "s" : ""} before`;
  }
  const h = Math.round(minutes / 60);
  return `${h} hour${h > 1 ? "s" : ""} before`;
}

/** Resolves "november 10", "friday 2pm" etc. into an instant. Reminders default
 * to 9am local when no time is given — a nudge at midnight is useless. */
function resolveWhen(ctx: ToolContext, raw: string): string | null {
  const d = parseDeadlineDate(raw.toLowerCase(), ctx.today);
  if (!d) return null;
  const minute = parseTimeInText(raw);
  const hour = minute != null ? Math.floor(minute / 60) : 9;
  const min = minute != null ? minute % 60 : 0;
  return zonedTimeToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), hour, min, ctx.timezone).toISOString();
}

export function buildTodoReminderTools(ctx: ToolContext) {
  const { supabase, userId } = ctx;

  const add_todo = betaTool({
    name: "add_todo",
    description:
      'Add a line to a named to-do list. Use this for things that need DOING but not SCHEDULING — no hours, no calendar block ("add write email to Rich to my This Week list", "put review the draft on my before-meeting list"). Creates the list if it does not exist yet. If the user gives an amount of time or wants it on the calendar, that is Work — use add_task instead.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the to-do line itself" },
        list: { type: "string", description: 'name of the list, e.g. "This week". Defaults to "General".' },
      },
      required: ["text"],
    },
    run: async ({ text, list }) => {
      const listName = (list ?? "General").trim() || "General";
      const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId);
      const existing = findByTitle((lists ?? []).map((l) => ({ ...l, title: l.name })), listName).match;

      let listId = existing?.id;
      let created = false;
      if (!listId) {
        const { data: madeList, error } = await supabase
          .from("todo_lists")
          .insert({ user_id: userId, name: listName })
          .select("id")
          .single();
        if (error || !madeList) return `Couldn't create the "${listName}" list.`;
        listId = madeList.id;
        created = true;
      }

      const { error } = await supabase.from("todo_items").insert({ user_id: userId, list_id: listId, text });
      if (error) return `Couldn't add that to "${listName}".`;
      markMutated(ctx);
      const onList = existing?.name ?? listName;
      return `Added "${text}" to the ${onList} list${created ? " (new list)" : ""}. It's a checklist item — no calendar time was booked for it.`;
    },
  });

  const complete_todo = betaTool({
    name: "complete_todo",
    description: "Tick off a to-do item by its text (fuzzy match). Use for 'I sent the email to Rich', 'mark X done on my list'.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the item to tick off (fuzzy)" },
        list: { type: "string", description: "narrow to one list if the same wording appears on several" },
      },
      required: ["text"],
    },
    run: async ({ text, list }) => {
      let query = supabase.from("todo_items").select("id,text,list_id").eq("user_id", userId).eq("done", false);
      if (list) {
        const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId);
        const match = findByTitle((lists ?? []).map((l) => ({ ...l, title: l.name })), list).match;
        if (!match) return `No list matching "${list}".`;
        query = query.eq("list_id", match.id);
      }
      const { data: items } = await query;
      const found = findByTitle((items ?? []).map((i) => ({ ...i, title: i.text })), text);
      if (found.ambiguous.length) {
        return `"${text}" matches several items: ${found.ambiguous.map((i) => i.text).join(", ")}. Which one?`;
      }
      if (!found.match) return `No open to-do matching "${text}".`;
      await supabase
        .from("todo_items")
        .update({ done: true, completed_at: new Date().toISOString() })
        .eq("id", found.match.id);
      markMutated(ctx);
      return `Ticked off "${found.match.text}".`;
    },
  });

  const list_todos = betaTool({
    name: "list_todos",
    description: "Show to-do lists and their open items. Use when the user asks what's on a list, or what they should be picking up.",
    inputSchema: {
      type: "object",
      properties: { list: { type: "string", description: "just one list, by name" } },
    },
    run: async ({ list }) => {
      const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId).order("name");
      if (!lists?.length) return "No to-do lists yet.";
      const wanted = list ? [findByTitle(lists.map((l) => ({ ...l, title: l.name })), list).match].filter(Boolean) : lists;
      if (!wanted.length) return `No list matching "${list}".`;
      const { data: items } = await supabase
        .from("todo_items")
        .select("list_id,text,done")
        .eq("user_id", userId)
        .eq("done", false);
      return wanted
        .map((l) => {
          const open = (items ?? []).filter((i) => i.list_id === l!.id);
          return `${l!.name}: ${open.length ? open.map((i) => `- ${i.text}`).join("\n") : "(nothing open)"}`;
        })
        .join("\n\n");
    },
  });

  const add_reminder = betaTool({
    name: "add_reminder",
    description:
      'Set a dated reminder that arrives as a push notification, with one or more lead times. Use for "remind me a week before and a day before the IDSC seminar on November 10". A reminder does NOT occupy calendar time and is not Work — if the user also wants hours booked to prepare, make a separate add_task call for that.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "what the reminder is about" },
        when: { type: "string", description: 'the date (and optional time) it relates to, e.g. "november 10", "friday 2pm"' },
        leads: {
          type: "string",
          description:
            'when to be notified, relative to that date — a list is fine: "1 week before, 1 day before". Also accepts "on the day". Defaults to 1 day before.',
        },
        heading: { type: "string", description: 'grouping shown on the Reminders view, e.g. "Presentations", "Reviews"' },
        notes: { type: "string", description: "anything extra to include in the notification" },
      },
      required: ["title", "when"],
    },
    run: async ({ title, when, leads, heading, notes }) => {
      const dueAt = resolveWhen(ctx, when);
      if (!dueAt) return `Couldn't understand the date "${when}" — try "november 10", "friday", or "in 2 weeks".`;
      const leadMinutes = parseLeadMinutes(leads);
      const { error } = await supabase.from("reminders").insert({
        user_id: userId,
        title,
        due_at: dueAt,
        heading: heading?.trim() || null,
        notes: notes?.trim() || null,
        lead_minutes: leadMinutes,
      });
      if (error) return `Couldn't save that reminder.`;
      markMutated(ctx);
      const whenLabel = new Date(dueAt).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: ctx.timezone,
      });
      return `Reminder set: "${title}" on ${whenLabel}${heading ? ` under ${heading}` : ""}, notifying ${leadMinutes.map(describeLead).join(" and ")}. No calendar time was booked — ask separately if you want hours to prepare.`;
    },
  });

  const list_reminders = betaTool({
    name: "list_reminders",
    description: "Show upcoming reminders and their lead times, optionally within one heading.",
    inputSchema: {
      type: "object",
      properties: { heading: { type: "string" } },
    },
    run: async ({ heading }) => {
      let query = supabase
        .from("reminders")
        .select("title,heading,due_at,lead_minutes")
        .eq("user_id", userId)
        .gte("due_at", new Date().toISOString())
        .order("due_at");
      if (heading) query = query.ilike("heading", `%${heading}%`);
      const { data } = await query;
      if (!data?.length) return heading ? `No upcoming reminders under "${heading}".` : "No upcoming reminders.";
      return data
        .map(
          (r) =>
            `- ${r.title} — ${new Date(r.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: ctx.timezone })}${r.heading ? ` [${r.heading}]` : ""} (${r.lead_minutes.map(describeLead).join(", ")})`,
        )
        .join("\n");
    },
  });

  const remove_reminder = betaTool({
    name: "remove_reminder",
    description: "Delete a reminder by title (fuzzy match).",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    run: async ({ title }) => {
      const { data } = await supabase.from("reminders").select("id,title").eq("user_id", userId);
      const found = findByTitle(data ?? [], title);
      if (found.ambiguous.length) {
        return `"${title}" matches several reminders: ${found.ambiguous.map((r) => r.title).join(", ")}. Which one?`;
      }
      if (!found.match) return `No reminder matching "${title}".`;
      await supabase.from("reminders").delete().eq("id", found.match.id);
      markMutated(ctx);
      return `Removed the reminder "${found.match.title}".`;
    },
  });

  return [add_todo, complete_todo, list_todos, add_reminder, list_reminders, remove_reminder];
}
