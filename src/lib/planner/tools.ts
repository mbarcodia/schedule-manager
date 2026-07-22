// The planner's tool set is a strict superset of the assistant's: all ten
// scheduling tools reused verbatim, plus notes tools. Notes are the
// planner's long-term memory surface — durable knowledge (ideas, papers,
// decisions, updates) lives there rather than in chat history, which ages
// out of the prompt window.

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { buildTools, findTrackableId, type ToolContext } from "@/lib/assistant/tools";
import { fuzzyFindByTitle } from "@/lib/assistant/nlp-dates";
import type { Database } from "@/lib/supabase/database.types";

type NoteUpdate = Database["public"]["Tables"]["notes"]["Update"];

const KINDS = ["idea", "todo", "paper", "update", "other"] as const;

/** Resolves a note by fuzzy title match against the user's notes. */
async function findNote(ctx: ToolContext, needle: string) {
  const { data: notes } = await ctx.supabase
    .from("notes")
    .select("id,title,content,kind,project_id,proposal_id,task_id")
    .eq("user_id", ctx.userId);
  return fuzzyFindByTitle(notes ?? [], needle) ?? null;
}

/** Resolves a link phrase to a trackable: projects and proposals first
 * (via the assistant's shared helper), then tasks. */
async function resolveLink(
  ctx: ToolContext,
  needle: string,
): Promise<{ project_id?: string; proposal_id?: string; task_id?: string; title: string } | null> {
  const trackable = await findTrackableId(ctx, needle);
  if (trackable?.projectId) return { project_id: trackable.projectId, title: trackable.title };
  if (trackable?.proposalId) return { proposal_id: trackable.proposalId, title: trackable.title };
  const { data: tasks } = await ctx.supabase.from("tasks").select("id,title").eq("user_id", ctx.userId);
  const task = fuzzyFindByTitle(tasks ?? [], needle);
  if (task) return { task_id: task.id, title: task.title };
  return null;
}

function notesTools(ctx: ToolContext) {
  const { supabase, userId } = ctx;

  const create_note = betaTool({
    name: "create_note",
    description:
      "Create a note (markdown). Use notes to durably store project knowledge: ideas, paper references, decisions, status updates. Optionally link it to a project, proposal, or task by title.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "Markdown body." },
        kind: { type: "string", enum: [...KINDS] },
        link_to: { type: "string", description: "Fuzzy title of a project, proposal, or task to attach this note to." },
      },
      required: ["title", "content"],
    },
    run: async ({ title, content, kind, link_to }) => {
      let link: Awaited<ReturnType<typeof resolveLink>> = null;
      if (link_to) {
        link = await resolveLink(ctx, link_to);
        if (!link) return `Nothing matching "${link_to}" to link to — note not created. Retry without link_to, or use the exact title.`;
      }
      const { error } = await supabase.from("notes").insert({
        user_id: userId,
        title,
        content,
        kind: kind && (KINDS as readonly string[]).includes(kind) ? (kind as (typeof KINDS)[number]) : "other",
        project_id: link?.project_id ?? null,
        proposal_id: link?.proposal_id ?? null,
        task_id: link?.task_id ?? null,
      });
      if (error) return `Couldn't create the note: ${error.message}`;
      return `Created note "${title}"${link ? ` linked to ${link.title}` : ""}.`;
    },
  });

  const update_note = betaTool({
    name: "update_note",
    description:
      "Update an existing note by fuzzy title. mode 'append' adds to the end (default); mode 'replace' overwrites the whole body. Can also rename or relink it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Fuzzy title of the note to update." },
        content: { type: "string", description: "Markdown to append or the full replacement body." },
        mode: { type: "string", enum: ["append", "replace"] },
        new_title: { type: "string" },
        link_to: { type: "string", description: "Fuzzy title of a project, proposal, or task to relink to." },
      },
      required: ["title"],
    },
    run: async ({ title, content, mode, new_title, link_to }) => {
      const note = await findNote(ctx, title);
      if (!note) return `No note matching "${title}".`;
      const patch: NoteUpdate = { updated_at: new Date().toISOString() };
      if (content != null) {
        patch.content = mode === "replace" ? content : note.content ? `${note.content}\n\n${content}` : content;
      }
      if (new_title) patch.title = new_title;
      if (link_to) {
        const link = await resolveLink(ctx, link_to);
        if (!link) return `Nothing matching "${link_to}" to link to — note unchanged.`;
        patch.project_id = link.project_id ?? null;
        patch.proposal_id = link.proposal_id ?? null;
        patch.task_id = link.task_id ?? null;
      }
      const { error } = await supabase.from("notes").update(patch).eq("id", note.id);
      if (error) return `Couldn't update the note: ${error.message}`;
      return `Updated note "${new_title ?? note.title}".`;
    },
  });

  const read_note = betaTool({
    name: "read_note",
    description:
      "Read a note's full markdown content by fuzzy title. The system prompt only carries a preview — read before editing or relying on a note's details.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }) => {
      const note = await findNote(ctx, title);
      if (!note) return `No note matching "${title}".`;
      return `# ${note.title} [${note.kind}]\n\n${note.content || "(empty)"}`;
    },
  });

  const delete_note = betaTool({
    name: "delete_note",
    description: "Delete a note by fuzzy title.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }) => {
      const note = await findNote(ctx, title);
      if (!note) return `No note matching "${title}".`;
      const { error } = await supabase.from("notes").delete().eq("id", note.id);
      if (error) return `Couldn't delete the note: ${error.message}`;
      return `Deleted note "${note.title}".`;
    },
  });

  const list_notes = betaTool({
    name: "list_notes",
    description:
      "List notes, optionally filtered to those linked to a project/proposal/task (fuzzy title). Useful after creating notes this turn — the system-prompt index is a turn-start snapshot.",
    inputSchema: { type: "object", properties: { linked_to: { type: "string" } } },
    run: async ({ linked_to }) => {
      let query = supabase
        .from("notes")
        .select("title,kind,updated_at,project_id,proposal_id,task_id")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });
      if (linked_to) {
        const link = await resolveLink(ctx, linked_to);
        if (!link) return `Nothing matching "${linked_to}".`;
        if (link.project_id) query = query.eq("project_id", link.project_id);
        else if (link.proposal_id) query = query.eq("proposal_id", link.proposal_id);
        else if (link.task_id) query = query.eq("task_id", link.task_id);
      }
      const { data: notes } = await query;
      if (!notes?.length) return "No notes yet.";
      return notes.map((n) => `- [${n.kind}] ${n.title} (updated ${n.updated_at.slice(0, 10)})`).join("\n");
    },
  });

  return [create_note, update_note, read_note, delete_note, list_notes];
}

export function buildPlannerTools(ctx: ToolContext) {
  return [...buildTools(ctx), ...notesTools(ctx)];
}
