// The planner's tool set is a strict superset of the assistant's: all ten
// scheduling tools reused verbatim, plus notes tools. Notes are the
// planner's long-term memory surface — durable knowledge (ideas, papers,
// decisions, updates) lives there rather than in chat history, which ages
// out of the prompt window.

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { buildTools, findTrackableId, markMutated, type ToolContext } from "@/lib/assistant/tools";
import { findByTitle } from "@/lib/assistant/nlp-dates";
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
    .select("id,title,content,kind,project_id,proposal_id,task_id,goal_id,created_at,updated_at,user_id")
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
  | { status: "found"; project_id?: string; proposal_id?: string; goal_id?: string; task_id?: string; title: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" };

/** Resolves a link phrase to a trackable a note can attach to: project or
 * proposal first (via the assistant's shared helper), then goal, then
 * task. Each tier reports its own ambiguity rather than falling through to
 * the next (a tie within "projects/proposals" must not silently become a
 * task match). */
async function resolveLink(ctx: ToolContext, needle: string): Promise<LinkResolution> {
  const trackable = await findTrackableId(ctx, needle);
  if (trackable.status === "ambiguous") return { status: "ambiguous", candidates: trackable.candidates };
  if (trackable.status === "found") {
    console.log(`[planner] link resolved: needle=${JSON.stringify(needle)} -> title=${JSON.stringify(trackable.title)} (project/proposal)`);
    return trackable.projectId
      ? { status: "found", project_id: trackable.projectId, title: trackable.title }
      : { status: "found", proposal_id: trackable.proposalId!, title: trackable.title };
  }

  const { data: goals } = await ctx.supabase.from("goals").select("id,title").eq("user_id", ctx.userId);
  const goalResult = findByTitle(goals ?? [], needle);
  if (goalResult.ambiguous.length) return { status: "ambiguous", candidates: goalResult.ambiguous.map((g) => g.title) };
  if (goalResult.match) {
    console.log(`[planner] link resolved: needle=${JSON.stringify(needle)} -> id=${goalResult.match.id} title=${JSON.stringify(goalResult.match.title)} (goal)`);
    return { status: "found", goal_id: goalResult.match.id, title: goalResult.match.title };
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
      "Create a note (markdown). Use notes to durably store project knowledge: ideas, paper references, decisions, status updates. Optionally link it to a project, proposal, goal, or task by title.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "Markdown body." },
        kind: { type: "string", enum: [...KINDS] },
        link_to: { type: "string", description: "Fuzzy title of a project, proposal, goal, or task to attach this note to." },
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
            proposal_id: link?.status === "found" ? (link.proposal_id ?? null) : null,
            goal_id: link?.status === "found" ? (link.goal_id ?? null) : null,
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
        link_to: { type: "string", description: "Fuzzy title of a project, proposal, goal, or task to relink to." },
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
          patch.proposal_id = link.proposal_id ?? null;
          patch.goal_id = link.goal_id ?? null;
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
      "List notes, optionally filtered to those linked to a project/proposal/goal/task (fuzzy title). Useful after creating notes this turn — the system-prompt index is a turn-start snapshot.",
    inputSchema: { type: "object", properties: { linked_to: { type: "string" } } },
    run: async ({ linked_to }) =>
      serialize(async () => {
        let query = supabase
          .from("notes")
          .select("title,kind,updated_at,project_id,proposal_id,goal_id,task_id")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false });
        if (linked_to) {
          const link = await resolveLink(ctx, linked_to);
          if (link.status === "ambiguous") {
            return `"${linked_to}" matches multiple items: ${link.candidates.join(", ")}. Say which one (use its exact title).`;
          }
          if (link.status === "none") return `Nothing matching "${linked_to}".`;
          if (link.project_id) query = query.eq("project_id", link.project_id);
          else if (link.proposal_id) query = query.eq("proposal_id", link.proposal_id);
          else if (link.goal_id) query = query.eq("goal_id", link.goal_id);
          else if (link.task_id) query = query.eq("task_id", link.task_id);
        }
        const { data: notes } = await query;
        if (!notes?.length) return "No notes yet.";
        return notes.map((n) => `- [${n.kind}] ${n.title} (updated ${n.updated_at.slice(0, 10)})`).join("\n");
      }),
  });

  return [create_note, update_note, read_note, delete_note, list_notes];
}

export function buildPlannerTools(ctx: ToolContext) {
  return [...buildTools(ctx), ...notesTools(ctx)];
}
