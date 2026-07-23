"use client";

import { CheckIcon } from "@phosphor-icons/react";
import { computeBlockVisual, type BlockLane } from "@/lib/scheduling/render";
import type { Category, ScheduleBlock } from "@/lib/scheduling/types";

// A block shorter than this (e.g. a 15-min Emails anchor) renders at this
// height instead of its true proportional one — otherwise there's no room
// for legible text at all. It'll visually extend a bit past its real end
// time into whatever's next; same tradeoff every calendar UI (Google
// Calendar included) makes for very short events.
const MIN_BLOCK_HEIGHT_PX = 26;

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
  const visual = computeBlockVisual(block, { atRiskTitles, nearDeadlineTitles, categories });
  if (!visual) return null;

  const compact = visual.density !== "full";
  const checkSize = compact ? 12 : 18;
  // Anything under half an hour is too squeezed to also fit a category tag
  // (e.g. the 15-min morning Emails block) — drop it entirely rather than
  // cram it in illegibly.
  const showTag = block.end - block.start >= 30;
  const futureTask = visual.isTask && !block.status;
  const clickable = visual.isTask || block.type === "synced";
  // Anchors (recurring blocks) have no "pin done early" concept — a fixed
  // daily slot doesn't free up remaining duration the way a task's does —
  // so only tasks get the pin/unpin flow; anything else just toggles a
  // plain done/not-done via progress_log.
  const showInlineStatus = compact && !!visual.statusLabel;

  function handleCheckClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (block.type === "task") {
      if (block.pinned) onUnpinDone();
      else if (futureTask) onPinDone();
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
        height: Math.max(MIN_BLOCK_HEIGHT_PX, visual.height - 2),
        background: visual.bg,
        border: `${visual.borderWidth}px ${visual.borderStyle} ${visual.border}`,
        borderRadius: 8,
        padding: `${compact ? 2 : 6}px 8px`,
        overflow: "hidden",
        boxSizing: "border-box",
        opacity: visual.opacity,
        cursor: clickable ? "pointer" : "default",
        // Overrides just the left edge, applied after the shorthand border
        // above — distinguishes which connected calendar a meeting came
        // from without recoloring the whole block.
        ...(visual.accentColor
          ? { borderLeftWidth: 3, borderLeftColor: visual.accentColor, borderLeftStyle: "solid" as const }
          : {}),
      }}
    >
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
          <div style={{ fontSize: 9, opacity: 0.65, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {visual.timeLabel}
          </div>
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
