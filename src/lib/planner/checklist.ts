// A project's step-by-step breakdown as a markdown checklist inside ONE
// note, rather than as separate scheduled tasks (migration/decision: large
// projects book one calendar block under their own name — see engine.ts's
// `research-${projectId}-w${week}` — and their internal steps live here
// instead, since decomposing them into discrete tasks stopped working).
//
// One `notes` row per project, `kind='todo'`, `content` holding one
// `- [ ] text` / `- [x] text` line per item. Deliberately plain markdown
// rather than a separate table: it reuses every existing note tool
// (create/read/update/delete, trash, chat) with zero new schema, and reads
// fine as plain text if you open the row directly.

const ITEM_RE = /^(\s*)-\s\[([ xX])\]\s(.*)$/;

export interface ChecklistItem {
  /** Line index within content.split("\n") — how a toggle addresses one item
   * without disturbing the others. */
  line: number;
  checked: boolean;
  text: string;
}

/** Every checklist line in a note's content, in order. Lines that aren't a
 * `- [ ]`/`- [x]` item (blank lines, a stray paragraph) are simply skipped —
 * this reads the checklist inside the content, not the whole content. */
export function parseChecklist(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  content.split("\n").forEach((raw, line) => {
    const m = ITEM_RE.exec(raw);
    if (m) items.push({ line, checked: m[2].toLowerCase() === "x", text: m[3] });
  });
  return items;
}

/** Flips one line's checkbox, leaving every other line — including its own
 * indentation and any non-checklist text around it — untouched. */
export function toggleChecklistLine(content: string, line: number, checked: boolean): string {
  const lines = content.split("\n");
  const m = ITEM_RE.exec(lines[line] ?? "");
  if (!m) return content;
  lines[line] = `${m[1]}- [${checked ? "x" : " "}] ${m[3]}`;
  return lines.join("\n");
}

/** Appends one new, unchecked item. A blank separator line only when the
 * note already has content — an empty checklist shouldn't start with one. */
export function appendChecklistItem(content: string, text: string): string {
  const trimmed = content.trim();
  return trimmed ? `${content.replace(/\s+$/, "")}\n- [ ] ${text}` : `- [ ] ${text}`;
}

/** Fuzzy-matches one checklist item by its text — case-insensitive substring,
 * either direction, same rule findByTitle uses for everything else a person
 * names loosely. Ambiguous ties are reported rather than guessed. */
export function findChecklistItem(
  items: ChecklistItem[],
  needle: string,
): { match: ChecklistItem | null; ambiguous: ChecklistItem[] } {
  const n = needle.toLowerCase().trim();
  const hits = items.filter((i) => {
    const t = i.text.toLowerCase();
    return t.includes(n) || n.includes(t);
  });
  const exact = hits.filter((i) => i.text.toLowerCase() === n);
  if (exact.length === 1) return { match: exact[0], ambiguous: [] };
  if (hits.length === 1) return { match: hits[0], ambiguous: [] };
  if (hits.length > 1) return { match: null, ambiguous: hits };
  return { match: null, ambiguous: [] };
}
