// The planner's tool set is a strict superset of the assistant's: all ten
// scheduling tools reused verbatim, plus notes tools. Notes are the
// planner's long-term memory surface — durable knowledge (ideas, papers,
// decisions, updates) lives there rather than in chat history, which ages
// out of the prompt window.

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { buildTools, findTrackableId, markMutated, type ToolContext } from "@/lib/assistant/tools";
import { findByTitle } from "@/lib/assistant/nlp-dates";
import { buildTodoReminderTools } from "./todo-reminder-tools";
import type { Database } from "@/lib/supabase/database.types";

type NoteRow = Database["public"]["Tables"]["notes"]["Row"];
type NoteUpdate = Database["public"]["Tables"]["notes"]["Update"];

const KINDS = ["idea", "todo", "paper", "update", "other"] as const;

type NoteLookup = { match: NoteRow | null; ambiguous: NoteRow[] };

/** Resolves a note by title (exact match wins; ambiguous ties are reported
 * rather than guessed — see findByTitle). */
async function findNote(ctx: ToolContext, needle: string): Promise<NoteLookup> {
  const { data: notes } = await ctx.supabase
    .from("notes")
    .select("id,title,content,kind,project_id,task_id,created_at,updated_at,user_id")
    .eq("user_id", ctx.userId);
  const result = findByTitle((notes ?? []) as NoteRow[], needle);
  if (result.match) {
    console.log(`[planner] note resolved: needle=${JSON.stringify(needle)} -> id=${result.match.id} title=${JSON.stringify(result.match.title)}`);
  }
  return result;
}

function ambiguousNoteMsg(needle: string, candidates: NoteRow[]): string {
  return `"${needle}" matches multiple notes: ${candidates.map((n) => n.title).join(", ")}. Say which one (use its exact title).`;
}

type LinkResolution =
  | { status: "found"; project_id?: string; task_id?: string; title: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" };

/** Resolves a link phrase to something a note can attach to: a project
 * first, then a piece of work. Each tier reports its own ambiguity rather than
 * falling through to the next, so a tie between two projects can't silently
 * become a match on some unrelated piece of work. */
async function resolveLink(ctx: ToolContext, needle: string): Promise<LinkResolution> {
  const project = await findTrackableId(ctx, needle);
  if (project.status === "ambiguous") return { status: "ambiguous", candidates: project.candidates };
  if (project.status === "found") {
    console.log(`[planner] link resolved: needle=${JSON.stringify(needle)} -> title=${JSON.stringify(project.title)} (project)`);
    return { status: "found", project_id: project.projectId, title: project.title };
  }

  const { data: tasks } = await ctx.supabase.from("tasks").select("id,title").eq("user_id", ctx.userId);
  const taskResult = findByTitle(tasks ?? [], needle);
  if (taskResult.ambiguous.length) return { status: "ambiguous", candidates: taskResult.ambiguous.map((t) => t.title) };
  if (taskResult.match) {
    console.log(`[planner] link resolved: needle=${JSON.stringify(needle)} -> id=${taskResult.match.id} title=${JSON.stringify(taskResult.match.title)} (task)`);
    return { status: "found", task_id: taskResult.match.id, title: taskResult.match.title };
  }

  return { status: "none" };
}

/** The SDK's tool runner executes every tool call within a turn concurrently
 * (Promise.all) — but update_note's append is a read-modify-write (fetch
 * content, concatenate in JS, write back), which isn't safe under
 * concurrent execution: two racing calls can compute their patch from the
 * same stale snapshot and clobber each other, and a racing read_note can
 * complete before a racing update_note commits, returning pre-write
 * content. Serializing all notes-tool calls onto one queue, in the order
 * Claude issued them, removes the race without touching the DB schema. */
function serializer() {
  let chain: Promise<unknown> = Promise.resolve();
  return function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn, fn);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function notesTools(ctx: ToolContext) {
  const { supabase, userId } = ctx;
  const serialize = serializer();

  const create_note = betaTool({
    name: "create_note",
    description:
      "Create a note (markdown). Use notes to durably store what you learn about a project: ideas, paper references, decisions, status updates. Optionally link it to a project or to a specific piece of work by title.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "Markdown body." },
        kind: { type: "string", enum: [...KINDS] },
        link_to: { type: "string", description: "Fuzzy title of the project or piece of work to attach this note to." },
      },
      required: ["title", "content"],
    },
    run: async ({ title, content, kind, link_to }) =>
      serialize(async () => {
        let link: LinkResolution | null = null;
        if (link_to) {
          link = await resolveLink(ctx, link_to);
          if (link.status === "ambiguous") {
            return `"${link_to}" matches multiple items: ${link.candidates.join(", ")}. Say which one (use its exact title) — note not created.`;
          }
          if (link.status === "none") {
            return `Nothing matching "${link_to}" to link to — note not created. Retry without link_to, or use the exact title.`;
          }
        }
        const { data: inserted, error } = await supabase
          .from("notes")
          .insert({
            user_id: userId,
            title,
            content,
            kind: kind && (KINDS as readonly string[]).includes(kind) ? (kind as (typeof KINDS)[number]) : "other",
            project_id: link?.status === "found" ? (link.project_id ?? null) : null,
            task_id: link?.status === "found" ? (link.task_id ?? null) : null,
          })
          .select("id")
          .single();
        if (error) return `Couldn't create the note: ${error.message}`;
        markMutated(ctx);
        console.log(`[planner] create_note: id=${inserted?.id} title=${JSON.stringify(title)}`);
        return `Created note "${title}"${link?.status === "found" ? ` linked to ${link.title}` : ""}.`;
      }),
  });

  const update_note = betaTool({
    name: "update_note",
    description:
      "Update an existing note by title. mode 'append' adds to the end (default); mode 'replace' overwrites the whole body. Can also rename or relink it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the note to update — exact title always resolves; fuzzy only if unambiguous." },
        content: { type: "string", description: "Markdown to append or the full replacement body." },
        mode: { type: "string", enum: ["append", "replace"] },
        new_title: { type: "string" },
        link_to: { type: "string", description: "Fuzzy title of the project or piece of work to relink to." },
      },
      required: ["title"],
    },
    run: async ({ title, content, mode, new_title, link_to }) =>
      serialize(async () => {
        const { match: note, ambiguous } = await findNote(ctx, title);
        if (ambiguous.length) return ambiguousNoteMsg(title, ambiguous);
        if (!note) return `No note matching "${title}".`;
        const patch: NoteUpdate = { updated_at: new Date().toISOString() };
        if (content != null) {
          patch.content = mode === "replace" ? content : note.content ? `${note.content}\n\n${content}` : content;
        }
        if (new_title) patch.title = new_title;
        if (link_to) {
          const link = await resolveLink(ctx, link_to);
          if (link.status === "ambiguous") {
            return `"${link_to}" matches multiple items: ${link.candidates.join(", ")}. Say which one (use its exact title) — note unchanged.`;
          }
          if (link.status === "none") return `Nothing matching "${link_to}" to link to — note unchanged.`;
          patch.project_id = link.project_id ?? null;
          patch.task_id = link.task_id ?? null;
        }
        // .select().single() confirms the write actually landed (and
        // returns the true persisted row) instead of trusting the local
        // patch — an update matching zero rows (e.g. blocked by RLS)
        // otherwise looks identical to success.
        const { data: confirmed, error } = await supabase
          .from("notes")
          .update(patch)
          .eq("id", note.id)
          .select("title,content")
          .single();
        if (error || !confirmed) return `Couldn't update the note: ${error?.message ?? "write did not persist"}`;
        markMutated(ctx);
        console.log(`[planner] update_note: id=${note.id} title=${JSON.stringify(confirmed.title)}`);
        return `Updated note "${confirmed.title}".`;
      }),
  });

  const read_note = betaTool({
    name: "read_note",
    description:
      "Read a note's full markdown content by title. The system prompt only carries a preview — read before editing or relying on a note's details.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }) =>
      serialize(async () => {
        const { match: note, ambiguous } = await findNote(ctx, title);
        if (ambiguous.length) return ambiguousNoteMsg(title, ambiguous);
        if (!note) return `No note matching "${title}".`;
        return `# ${note.title} [${note.kind}]\n\n${note.content || "(empty)"}`;
      }),
  });

  const delete_note = betaTool({
    name: "delete_note",
    description: "Delete a note by title.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }) =>
      serialize(async () => {
        const { match: note, ambiguous } = await findNote(ctx, title);
        if (ambiguous.length) return ambiguousNoteMsg(title, ambiguous);
        if (!note) return `No note matching "${title}".`;
        const { error } = await supabase.from("notes").delete().eq("id", note.id);
        if (error) return `Couldn't delete the note: ${error.message}`;
        markMutated(ctx);
        console.log(`[planner] delete_note: id=${note.id} title=${JSON.stringify(note.title)}`);
        return `Deleted note "${note.title}".`;
      }),
  });

  const list_notes = betaTool({
    name: "list_notes",
    description:
      "List notes, optionally filtered to those linked to one project or piece of work (fuzzy title). Useful after creating notes this turn — the system-prompt index is a turn-start snapshot.",
    inputSchema: { type: "object", properties: { linked_to: { type: "string" } } },
    run: async ({ linked_to }) =>
      serialize(async () => {
        let query = supabase
          .from("notes")
          .select("title,kind,updated_at,project_id,task_id")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false });
        if (linked_to) {
          const link = await resolveLink(ctx, linked_to);
          if (link.status === "ambiguous") {
            return `"${linked_to}" matches multiple items: ${link.candidates.join(", ")}. Say which one (use its exact title).`;
          }
          if (link.status === "none") return `Nothing matching "${linked_to}".`;
          if (link.project_id) query = query.eq("project_id", link.project_id);
          else if (link.task_id) query = query.eq("task_id", link.task_id);
        }
        const { data: notes } = await query;
        if (!notes?.length) return "No notes yet.";
        return notes.map((n) => `- [${n.kind}] ${n.title} (updated ${n.updated_at.slice(0, 10)})`).join("\n");
      }),
  });

  return [create_note, update_note, read_note, delete_note, list_notes];
}

function archiveTools(ctx: ToolContext) {
  const { supabase, userId } = ctx;

  const archive_task = betaTool({
    name: "archive_task",
    description:
      "Archive a piece of work instead of deleting it: it leaves the schedule and board but keeps its row and logged-hours history forever (restorable from the board's Archive view). PREFER this over remove_item when the user is done with something — deletion destroys the record of the work.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "Fuzzy title of the work to archive." } },
      required: ["title"],
    },
    run: async ({ title }) => {
      const { data: tasks } = await supabase
        .from("tasks")
        .select("id,title")
        .eq("user_id", userId)
        .is("archived_at", null);
      const result = findByTitle(tasks ?? [], title);
      if (result.ambiguous.length) {
        return `"${title}" matches more than one thing: ${result.ambiguous.map((t) => t.title).join(", ")}. Say which one (use its exact title).`;
      }
      if (!result.match) return `No active work matching "${title}".`;
      await supabase.from("tasks").update({ archived_at: new Date().toISOString() }).eq("id", result.match.id);
      markMutated(ctx);
      return `Archived "${result.match.title}" — off the schedule, history kept. It can be restored from the board's Archive view.`;
    },
  });

  const list_archived_tasks = betaTool({
    name: "list_archived_tasks",
    description:
      "List archived (completed or retired) work with its logged hours, optionally within an archived-date range — the data source for retrospectives like 'what did I get done this semester?'.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Earliest archived date, YYYY-MM-DD (inclusive). Omit for no lower bound." },
        to: { type: "string", description: "Latest archived date, YYYY-MM-DD (inclusive). Omit for no upper bound." },
      },
    },
    run: async ({ from, to }) => {
      let query = supabase
        .from("tasks")
        .select("id,title,duration_min,deadline_at,archived_at,category_id")
        .eq("user_id", userId)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false });
      if (from) query = query.gte("archived_at", from);
      if (to) query = query.lte("archived_at", `${to}T23:59:59Z`);
      const [{ data: tasks }, { data: categories }] = await Promise.all([
        query,
        supabase.from("categories").select("id,name").eq("user_id", userId),
      ]);
      if (!tasks?.length) return "No archived work in that range.";

      const { data: log } = await supabase
        .from("progress_log")
        .select("subject_id,start_min,end_min,minutes_done")
        .eq("user_id", userId)
        .eq("subject_type", "task")
        .in(
          "subject_id",
          tasks.map((t) => t.id),
        );
      const minutesByTask = new Map<string, number>();
      for (const row of log ?? []) {
        const done = row.minutes_done ?? row.end_min - row.start_min;
        minutesByTask.set(row.subject_id, (minutesByTask.get(row.subject_id) ?? 0) + done);
      }
      const catName = new Map((categories ?? []).map((c) => [c.id, c.name]));

      return tasks
        .map((t) => {
          const logged = minutesByTask.get(t.id);
          const cat = t.category_id ? catName.get(t.category_id) : null;
          return `- ${t.title}${cat ? ` [${cat}]` : ""} — archived ${t.archived_at!.slice(0, 10)}${
            logged ? `, ${Math.round((logged / 60) * 10) / 10}h logged` : ""
          }${t.deadline_at ? `, was due ${t.deadline_at.slice(0, 10)}` : ""}`;
        })
        .join("\n");
    },
  });

  return [archive_task, list_archived_tasks];
}

export function buildPlannerTools(ctx: ToolContext) {
  return [...buildTools(ctx), ...notesTools(ctx), ...archiveTools(ctx), ...buildTodoReminderTools(ctx)];
}
