"use client";

import { Fragment } from "react";
import { minToLabel, WEEKDAY_LABELS } from "@/lib/scheduling/time";
import type { ScheduleBlock } from "@/lib/scheduling/types";

interface EventDetailPopoverProps {
  block: ScheduleBlock;
  top: number;
  onClose: () => void;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** Splits text on URLs and renders the matched spans as real links —
 * everything else stays as plain, auto-escaped text (never
 * dangerouslySetInnerHTML), since feed content is third-party/untrusted. */
function linkify(text: string): React.ReactNode[] {
  const parts = text.split(URL_PATTERN);
  const urls = text.match(URL_PATTERN) ?? [];
  const out: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part) out.push(<Fragment key={`t${i}`}>{part}</Fragment>);
    if (urls[i]) {
      out.push(
        <a
          key={`u${i}`}
          href={urls[i]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-text underline underline-offset-2 break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {urls[i]}
        </a>,
      );
    }
  });
  return out;
}

/** Detail popover for a synced meeting block — shows what came in from the
 * calendar feed (location, notes, join link) so this can stand in for
 * actually opening Outlook/iCloud/Google. Notes are rendered as plain text
 * (never HTML) since feed content is third-party and untrusted. */
export function EventDetailPopover({ block, top, onClose }: EventDetailPopoverProps) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: Math.max(0, top),
        right: 2,
        zIndex: 10,
        background: "#232532",
        border: "1px solid rgba(233,233,237,0.25)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        minWidth: 220,
        maxWidth: 280,
        overflow: "hidden",
      }}
    >
      <div className="px-2.5 py-2 border-b border-white/10">
        <div className="text-[11.5px] font-medium text-text">{block.title}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted">
          <span>
            {WEEKDAY_LABELS[block.gday % 7]} {minToLabel(block.start)}–{minToLabel(block.end)}
          </span>
          {block.connectionLabel && (
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block rounded-full flex-none"
                style={{ width: 6, height: 6, background: block.connectionColor ?? "#75798c" }}
              />
              {block.connectionLabel}
            </span>
          )}
        </div>
        {block.location && <div className="mt-1 text-[10.5px] text-muted">📍 {block.location}</div>}
        {block.description && (
          <div className="mt-1.5 text-[10.5px] text-muted whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
            {linkify(block.description)}
          </div>
        )}
      </div>

      {block.meetingUrl && (
        <a
          href={block.meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="schedule-menu-item block text-accent"
          onClick={onClose}
        >
          Join meeting →
        </a>
      )}
    </div>
  );
}
