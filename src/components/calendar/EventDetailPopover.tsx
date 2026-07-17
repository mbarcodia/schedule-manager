"use client";

import { minToLabel, WEEKDAY_LABELS } from "@/lib/scheduling/time";
import type { ScheduleBlock } from "@/lib/scheduling/types";

interface EventDetailPopoverProps {
  block: ScheduleBlock;
  top: number;
  onClose: () => void;
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
        <div className="mt-1 text-[10.5px] text-muted">
          {WEEKDAY_LABELS[block.gday % 7]} {minToLabel(block.start)}–{minToLabel(block.end)}
        </div>
        {block.location && <div className="mt-1 text-[10.5px] text-muted">📍 {block.location}</div>}
        {block.description && (
          <div className="mt-1.5 text-[10.5px] text-muted whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
            {block.description}
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
