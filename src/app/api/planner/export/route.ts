import { createClient } from "@/lib/supabase/server";
import type { Database, NoteKind } from "@/lib/supabase/database.types";

type NoteRow = Database["public"]["Tables"]["notes"]["Row"];

const KIND_LABEL: Record<NoteKind, string> = {
  idea: "Idea",
  todo: "To-do",
  paper: "Paper",
  update: "Update",
  other: "Note",
};

function renderNote(n: NoteRow): string {
  return `### [${KIND_LABEL[n.kind]}] ${n.title}\n_updated ${n.updated_at.slice(0, 10)}_\n\n${n.content || "(empty)"}\n`;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in", { status: 401 });

  const [{ data: notes }, { data: projects }, { data: proposals }, { data: goals }, { data: tasks }] = await Promise.all([
    supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
    supabase.from("projects").select("id,title").eq("user_id", user.id),
    supabase.from("proposals").select("id,title").eq("user_id", user.id),
    supabase.from("goals").select("id,title").eq("user_id", user.id),
    supabase.from("tasks").select("id,title").eq("user_id", user.id),
  ]);

  const titleById = new Map<string, string>();
  (projects ?? []).forEach((p) => titleById.set(p.id, p.title));
  (proposals ?? []).forEach((p) => titleById.set(p.id, p.title));
  (goals ?? []).forEach((g) => titleById.set(g.id, g.title));
  (tasks ?? []).forEach((t) => titleById.set(t.id, t.title));

  const groups = new Map<string, NoteRow[]>();
  for (const n of notes ?? []) {
    const linkedId = n.project_id ?? n.proposal_id ?? n.goal_id ?? n.task_id;
    const heading = linkedId ? (titleById.get(linkedId) ?? "Unknown") : "Unlinked";
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading)!.push(n);
  }

  const sections = [...groups.entries()]
    .sort(([a], [b]) => (a === "Unlinked" ? 1 : b === "Unlinked" ? -1 : a.localeCompare(b)))
    .map(([heading, groupNotes]) => `## ${heading}\n\n${groupNotes.map(renderNote).join("\n")}`);

  const markdown = `# Planner Notes\nExported ${new Date().toISOString().slice(0, 10)}\n\n${
    sections.join("\n") || "No notes yet."
  }`;

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="planner-notes.md"',
    },
  });
}
