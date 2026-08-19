"use client";

import { useState } from "react";
import { CaretDownIcon, CaretRightIcon, ChatCircleTextIcon, WarningIcon } from "@phosphor-icons/react";
import { computeShortfall, type ShortfallOption, type WeekShortfall } from "@/lib/scheduling/shortfall";
import { askPlanner, RESOLVE_SHORTFALL_ASK } from "@/lib/planner/ask-planner";
import { fmtMin } from "@/lib/scheduling/time";
import type { ComputeScheduleResult, ScheduleInputs } from "@/lib/scheduling/types";

// The "didn't fit" banner already said WHAT fell short. This says what could be
// done about it, on the calendar rather than only when the chat is asked —
// a week that cannot hold its own commitments is exactly the thing you need to
// find out without knowing to look for it.
//
// NOTHING HERE IS AN APPLY BUTTON. Every option is a decision about someone's
// work — trimming a rate, moving a deadline, giving up a share target — and
// none is safe to apply from a click on a summary line. The one button hands
// the question to the planner, which is where the change gets made with its
// consequences reported. That keeps one path for writes rather than a second,
// quieter one that skips the "here is what this costs" step.

// What each option actually changes, in plain words.
//
// These are NOT verbs — each option's own sentence already starts with one
// ("Cut …", "Move …", "Defer …"), so a label like "Trim hours" read as "Trim
// hours Cut ocean-model-study from…". They are also not the internal
// vocabulary: "weekly rate" and "share target" name fields, which only helps
// if you already know the fields. Each says what would be different
// afterwards, so the list can be read without knowing how the scheduler is put
// together.
const KIND_LABEL: Record<ShortfallOption["kind"], string> = {
  defer: "Do it later",
  trim_weekly: "Ask for less each week",
  lower_label_target: "Expect less of the week",
  move_deadline: "Push back a deadline",
};

/** The line under each heading. Same job as the heading: say what changes, not
 * which column it lives in. */
const KIND_BLURB: Record<ShortfallOption["kind"], string> = {
  defer: "Keep the hours — move them to a week with room.",
  trim_weekly: "Lower how many hours this commitment asks for every week.",
  lower_label_target: "Lower the share of the week this whole area is meant to get.",
  move_deadline: "Move dated work aside — the one thing weekly hours can never outrank.",
};

/** Grouped so the four kinds read as four kinds of answer, rather than one
 * ranked list in which every row looks like a variation of the row above. */
const KIND_ORDER: ShortfallOption["kind"][] = ["defer", "trim_weekly", "lower_label_target", "move_deadline"];

function WeekSection({ week }: { week: WeekShortfall }) {
  if (week.totalOwedMin <= 0) return null;
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: week.options.filter((o) => o.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-text font-medium">
        {week.weekLabel}: {fmtMin(week.totalOwedMin)} of work with nowhere to go, {fmtMin(week.freeMin)} free
      </div>
      <div className="text-[11px] text-muted mt-0.5">
        Short: {week.owed.map((o) => `${o.title} ${fmtMin(o.owedMin)}`).join(", ")}
      </div>

      {groups.map((g) => (
        <div key={g.kind} className="mt-2">
          <div className="text-[11px] text-accent-text font-medium">{KIND_LABEL[g.kind]}</div>
          <div className="text-[10.5px] text-muted-2">{KIND_BLURB[g.kind]}</div>
          <ul className="mt-1 flex flex-col gap-1">
            {g.items.map((o, i) => (
              <li key={i} className="text-[11px] leading-snug pl-2 border-l border-border">
                <span className="text-text">{o.label}</span>{" "}
                <span className="text-muted-2">— frees {fmtMin(o.freesMin)}</span>
                <div className="text-[10.5px] text-muted-2">{o.cost}</div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ShortfallPanel({
  inputs,
  schedule,
}: {
  inputs: ScheduleInputs;
  schedule: ComputeScheduleResult;
}) {
  // Collapsed by default: the headline is the part that has to be seen, and a
  // wall of options permanently open above the calendar would be scrolled past
  // within a day.
  const [open, setOpen] = useState(false);
  const weeks = computeShortfall(inputs, schedule).filter((w) => w.totalOwedMin > 0);
  if (!weeks.length) return null;

  const headline = weeks
    .map((w) => `${w.weekLabel.toLowerCase()} is ${fmtMin(w.totalOwedMin)} short`)
    .join(", ");

  return (
    <div className="flex-none bg-panel border-b border-border text-xs">
      <div className="px-[22px] py-2 flex items-center gap-3 flex-wrap">
        <WarningIcon size={14} weight="fill" className="flex-none text-accent" />
        <span className="text-accent-text min-w-0">More is booked than fits — {headline}.</span>

        <div className="ml-auto flex items-center gap-2 flex-none">
          {/* Hands the question over rather than answering it here: the planner
             can weigh the options against everything else it knows and say
             which it would take, which a static list cannot. */}
          <button
            onClick={() => askPlanner(RESOLVE_SHORTFALL_ASK)}
            title="Ask the planner to work through this with you"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 border border-border hover:border-accent hover:text-accent-text text-muted"
          >
            <ChatCircleTextIcon size={12} weight="bold" />
            Resolve with planner
          </button>
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-muted-2 hover:text-accent-text"
          >
            {open ? "Hide options" : "See options"}
            {open ? <CaretDownIcon size={11} weight="bold" /> : <CaretRightIcon size={11} weight="bold" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-[22px] pb-3 pt-0.5 flex flex-col gap-3">
          {weeks.map((w) => (
            <WeekSection key={w.weekIndex} week={w} />
          ))}
          <div className="text-[10.5px] text-muted-2 border-t border-border pt-2">
            Nothing here changes on its own — pick one in the chat and it will be made, with what it costs reported
            back.
          </div>
        </div>
      )}
    </div>
  );
}
