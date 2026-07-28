// The chat does two genuinely different jobs, and conflating them made both
// worse: a one-line edit doesn't want an interview, and a semester plan doesn't
// want a tool call fired off the first sentence. The mode is chosen explicitly
// in the UI so it's obvious which one you're in — and so the model choice and
// the behavioural contract can differ.

export type ChatMode = "quick" | "planning";

export const DEFAULT_CHAT_MODE: ChatMode = "quick";

export function isChatMode(value: unknown): value is ChatMode {
  return value === "quick" || value === "planning";
}

export interface ChatModeMeta {
  id: ChatMode;
  label: string;
  /** One line under the toggle — what this mode is for. */
  blurb: string;
  placeholder: string;
  /** Clickable openers, shown in planning mode where a blank box is daunting. */
  starters: { label: string; prompt: string }[];
}

export const CHAT_MODES: Record<ChatMode, ChatModeMeta> = {
  quick: {
    id: "quick",
    label: "Quick task",
    blurb: "One change, done immediately — no questions asked.",
    placeholder: 'e.g. "log 45 minutes on grading" or "move my gym block to 6pm"',
    starters: [],
  },
  planning: {
    id: "planning",
    label: "Planning session",
    blurb: "A guided conversation that fills out your planner boards.",
    placeholder: "Describe the stretch you want to plan — a semester, a month, a proposal…",
    starters: [
      {
        label: "Plan my semester",
        prompt:
          "Let's plan the whole semester. Ask me what you need — term dates, courses I'm teaching, proposal and paper deadlines, travel, and how much research time each project should get each week — then set it all up on my board.",
      },
      {
        label: "Plan this month",
        prompt:
          "Let's plan the next four weeks. Walk me through what's due, what's at risk, and what I should be protecting time for, then put it on the calendar.",
      },
      {
        label: "Set up a new project or proposal",
        prompt:
          "I want to add a new project. Interview me about the deadline, the work it breaks into, and how many hours a week it needs, then create it with its tasks.",
      },
      {
        label: "Weekly review",
        prompt:
          "Let's do a weekly review — what's overdue, what's stuck in progress too long, and what should I drop or reprioritise for next week?",
      },
      {
        label: "Set my scheduling rules",
        prompt:
          "I want to set standing rules for how you schedule my time — things like which hours are off limits, what should never be moved, and which work protects mornings. Ask me about each, then remember them.",
      },
    ],
  },
};

/** Appended to the system prompt so the model's contract matches the mode the
 * user picked. Kept here (not in the persona) because the persona is the cached
 * prefix — mode text has to sit in the per-turn half. */
export function modeInstruction(mode: ChatMode): string {
  if (mode === "quick") {
    return [
      "MODE: QUICK TASK. The user wants one change made now.",
      "Execute the request with the fewest tool calls that do the job, then confirm in a sentence or two.",
      "Do not open an interview, do not propose a plan, and do not ask what else they'd like to do.",
      "Ask a question only if the request genuinely cannot be executed without one (e.g. no date given at all).",
    ].join(" ");
  }
  return [
    "MODE: PLANNING SESSION. The user wants to think a longer stretch through with you and end with their board filled in.",
    "Open by asking what you actually need to know — a few questions at a time, never a questionnaire — and wait for answers before creating anything.",
    "Work outward from fixed commitments (term dates, teaching, deadlines, travel) to flexible work (research hours, writing, analysis).",
    "As facts land, write them down as you go rather than saving everything for the end: add_trackable for projects/proposals/goals, add_task for concrete work with durations and deadlines and pacing, update_recurring for anything weekly, adjust_day_hours for changed working days, and remember_rule for standing preferences.",
    "Mark what genuinely matters with update_task's important flag — that's what drives the Eisenhower view.",
    "Check realism out loud using the real numbers in the snapshot, and say plainly when a stretch is overcommitted and what would have to give.",
    "Close with a short summary of what you created and what the coming weeks now look like.",
  ].join(" ");
}
