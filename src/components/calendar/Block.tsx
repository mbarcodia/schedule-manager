"use client";

import { useState } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { computeBlockVisual, needsCompletionTime, type BlockLane } from "@/lib/scheduling/render";
import type { Category, ScheduleBlock } from "@/lib/scheduling/types";

// Blocks render at their true proportional height, inset 1px top and bottom so
// the gap between consecutive blocks is visible. There used to be a 26px floor
// for legibility, but a 15-minute block is only 18px, so the floor overran the
// following block by ~9px and swallowed the separation entirely — a 9:00-9:15
// block looked like it ran into whatever came next. Short blocks already switch
// to a compact layout (see ContentDensity), so they stay readable at their real
// height; this floor only keeps a pathologically short one clickable.
const ABSOLUTE_MIN_HEIGHT_PX = 8;

interface BlockProps {
  block: ScheduleBlock;
  atRiskTitles: string[];
  nearDeadlineTitles: string[];
  categories: Category[];
  layout?: BlockLane;
  onPinDone: () => void;
  onUnpinDone: () => void;
  onSetProgress: (mode: "done" | "partial" | "none", minutes?: number) => void;
  onBodyClick: () => void;
}

export function Block({
  block,
  atRiskTitles,
  nearDeadlineTitles,
  categories,
  layout,
  onPinDone,
  onUnpinDone,
  onSetProgress,
  onBodyClick,
}: BlockProps) {
  /** Open while we're asking which slot a completion belongs in. */
  const [asking, setAsking] = useState(false);

  const visual = computeBlockVisual(block, { atRiskTitles, nearDeadlineTitles, categories });
  if (!visual) return null;

  const compact = visual.density !== "full";
  const checkSize = compact ? 12 : 18;
  // Any block under 30 minutes — task, event, recurring or not — is too
  // squeezed for anything beyond title + checkmark. No time, no category
  // tag, no status text; cramming those in just makes it illegible.
  const ultraCompact = block.end - block.start < 30;
  const showTag = !ultraCompact;
  const clickable = visual.isTask || block.type === "synced";
  // Anchors (recurring blocks) have no "pin done early" concept — a fixed
  // daily slot doesn't free up remaining duration the way a task's does —
  // so only tasks get the pin/unpin flow; anything else just toggles a
  // plain done/not-done via progress_log.
  const showInlineStatus = compact && !!visual.statusLabel && !ultraCompact;

  function handleCheckClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (block.type === "task") {
      if (block.pinned) onUnpinDone();
      else if (needsCompletionTime(block, visual!.done)) setAsking(true);
      else onSetProgress(visual!.done ? "none" : "done");
    } else {
      onSetProgress(visual!.done ? "none" : "done");
    }
  }

  return (
    <div
      onClick={(e) => {
        if (clickable) {
          e.stopPropagation();
          onBodyClick();
        }
      }}
      title={visual.tooltip}
      style={{
        position: "absolute",
        left: `calc(${((layout?.lane ?? 0) / (layout?.lanes ?? 1)) * 100}% + 3px)`,
        width: `calc(${100 / (layout?.lanes ?? 1)}% - 6px)`,
        // Inset by 1px top/bottom so back-to-back blocks (e.g. two 15-min
        // anchors sharing an edge) show a visible sliver of separation
        // instead of their borders touching and blending together.
        top: visual.top + 1,
        // -2 = the 1px inset top and bottom that draws the separation.
        height: Math.max(ABSOLUTE_MIN_HEIGHT_PX, visual.height - 2),
        background: visual.bg,
        border: `${visual.borderWidth}px ${visual.borderStyle} ${visual.border}`,
        borderRadius: 8,
        padding: `${compact ? 2 : 6}px 8px`,
        overflow: asking ? "visible" : "hidden",
        boxSizing: "border-box",
        zIndex: asking ? 40 : undefined,
        opacity: asking ? 1 : visual.opacity,
        cursor: clickable ? "pointer" : "default",
        // Overrides just the left edge, applied after the shorthand border
        // above — carries the label colour without recolouring the whole
        // block, which is the treatment synced meetings use instead.
        ...(visual.accentColor
          ? { borderLeftWidth: 4, borderLeftColor: visual.accentColor, borderLeftStyle: "solid" as const }
          : {}),
      }}
    >
      {asking && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="rounded-md border border-border bg-panel shadow-lg p-2 flex flex-col gap-1"
          style={{ position: "absolute", top: 2, left: 2, zIndex: 3, minWidth: 148 }}
        >
          <div className="text-[9.5px] text-muted-2 leading-snug">When did you do it?</div>
          <button
            onClick={() => {
              setAsking(false);
              onSetProgress("done");
            }}
            className="text-left text-[10.5px] hover:text-accent-text"
          >
            In its original slot
          </button>
          <button
            onClick={() => {
              setAsking(false);
              onPinDone();
            }}
            className="text-left text-[10.5px] hover:text-accent-text"
          >
            Just now
          </button>
          <button onClick={() => setAsking(false)} className="text-left text-[9.5px] text-muted-2 hover:text-text">
            cancel
          </button>
        </div>
      )}

      {visual.canComplete && (
        <div
          style={{
            position: "absolute",
            top: compact ? 1 : 3,
            right: 3,
            display: "flex",
            alignItems: "center",
            gap: 3,
            zIndex: 2,
          }}
        >
          {showInlineStatus && (
            <span
              style={{
                fontSize: 7.5,
                color: visual.statusColor,
                fontWeight: 600,
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
              }}
            >
              {visual.statusLabel}
            </span>
          )}
          <button
            onClick={handleCheckClick}
            title={visual.done ? "Mark not done" : "Mark done"}
            style={{
              width: checkSize,
              height: checkSize,
              flex: "0 0 auto",
              borderRadius: "50%",
              border: `1px solid ${visual.done ? "#9184d9" : "rgba(233,233,237,0.4)"}`,
              background: visual.done ? "#9184d9" : "rgba(22,24,38,0.6)",
              color: visual.done ? "#161826" : "#e9e9ed",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
            }}
          >
            <CheckIcon size={9} weight="bold" />
          </button>
        </div>
      )}

      {visual.density === "full" ? (
        <>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              lineHeight: 1.25,
              color: visual.textColor,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              paddingRight: checkSize + 4,
            }}
          >
            {visual.title}
          </div>
          <div style={{ fontSize: 9.5, opacity: 0.65, marginTop: 2 }}>{visual.timeLabel}</div>
          {!showInlineStatus && visual.statusLabel && (
            <div style={{ fontSize: 9, color: visual.statusColor, marginTop: 2, fontWeight: 600, letterSpacing: "0.05em" }}>
              {visual.statusLabel}
            </div>
          )}
        </>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            height: "100%",
            paddingRight: checkSize + (showInlineStatus ? 32 : 6),
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 500,
              lineHeight: 1.2,
              color: visual.textColor,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {visual.title}
          </div>
          {!ultraCompact && (
            <div style={{ fontSize: 9, opacity: 0.65, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {visual.timeLabel}
            </div>
          )}
        </div>
      )}

      {/* Category tag — always horizontal, bottom-right corner, regardless
         of block size — except under 30 minutes, where there's no room. */}
      {showTag && (
        <div
          style={{
            position: "absolute",
            bottom: 3,
            right: 6,
            fontSize: visual.density === "full" ? 9 : 7,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            opacity: 0.6,
            whiteSpace: "nowrap",
            overflow: "hidden",
            maxWidth: "60%",
            textOverflow: "ellipsis",
            pointerEvents: "none",
          }}
        >
          {visual.tagLabel}
        </div>
      )}
    </div>
  );
}
