"use client";

import { useState } from "react";
import { CaretDownIcon, CaretRightIcon, WarningIcon } from "@phosphor-icons/react";
import { computeShortfall, type ShortfallOption, type WeekShortfall } from "@/lib/scheduling/shortfall";
import { fmtMin } from "@/lib/scheduling/time";
import type { ComputeScheduleResult, ScheduleInputs } from "@/lib/scheduling/types";

// The "didn't fit" banner already said WHAT fell short. This says what could be
// done about it, which is the half the user was left to work out alone — and it
// says it on the calendar rather than only when the chat is asked, because a
// week that cannot hold its own commitments is exactly the thing you need to
// find out without knowing to look for it.
//
// NOTHING HERE IS A BUTTON. Every option is a decision about someone's work —
// trimming a rate, moving a deadline, giving up a share target — and none of
// them is safe to apply on a click from a summary line. They are phrased so
// they can be said straight to the chat, which is where the change gets made
// with its consequences reported. That keeps one path for writes rather than a
// second, quieter one that skips the "here is what this costs" step.

// A category chip, NOT a verb — each option's own sentence already starts with
// one ("Cut …", "Move …", "Defer …"), so labelling these "Trim hours" inline
// read as "Trim hours Cut ocean-model-study from…". Uppercase and set apart so
// it groups the list without being read as part of the sentence.
const KIND_LABEL: Record<ShortfallOption["kind"], string> = {
  defer: "later week",
  trim_weekly: "weekly rate",
  lower_label_target: "share target",
  move_deadline: "dated work",
};

function WeekSection({ week }: { week: WeekShortfall }) {
  if (week.totalOwedMin <= 0) return null;
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-text font-medium">
        {week.weekLabel}: {fmtMin(week.totalOwedMin)} owed, {fmtMin(week.freeMin)} free
      </div>
      <div className="text-[11px] text-muted mt-0.5">
        Short: {week.owed.map((o) => `${o.title} ${fmtMin(o.owedMin)}`).join(", ")}
      </div>
      {week.options.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {week.options.map((o, i) => (
            <li key={i} className="text-[11px] leading-snug">
              <span
                className="text-accent-text mr-1.5"
                style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.75 }}
              >
                {KIND_LABEL[o.kind]}
              </span>
              <span className="text-text">{o.label}</span>{" "}
              <span className="text-muted-2">— frees {fmtMin(o.freesMin)}</span>
              <div className="text-[10.5px] text-muted-2">{o.cost}</div>
            </li>
          ))}
        </ul>
      )}
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
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-[22px] py-2 flex items-center gap-2 text-left hover:text-accent-text"
        title={open ? "Hide the options" : "Show what would have to give"}
      >
        <WarningIcon size={14} weight="fill" className="flex-none text-accent" />
        <span className="text-accent-text">More is booked than fits — {headline}.</span>
        <span className="text-muted-2 ml-auto flex items-center gap-1 flex-none">
          {open ? "Hide options" : "What would have to give"}
          {open ? <CaretDownIcon size={11} weight="bold" /> : <CaretRightIcon size={11} weight="bold" />}
        </span>
      </button>
      {open && (
        <div className="px-[22px] pb-3 pt-0.5 flex flex-col gap-3">
          {weeks.map((w) => (
            <WeekSection key={w.weekIndex} week={w} />
          ))}
          <div className="text-[10.5px] text-muted-2 border-t border-border pt-2">
            Nothing here changes on its own — say which one you want in the chat and it will be made, with what it
            costs reported back.
          </div>
        </div>
      )}
    </div>
  );
}
