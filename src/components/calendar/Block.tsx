"use client";

import { CheckIcon } from "@phosphor-icons/react";
import { computeBlockVisual, type BlockLane } from "@/lib/scheduling/render";
import type { Category, ScheduleBlock } from "@/lib/scheduling/types";

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

  const compact = visual.density === "compact";
  const checkSize = compact ? 12 : 18;
  const futureTask = visual.isTask && !block.status;
  const clickable = visual.isTask || block.type === "synced";

  function handleCheckClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (block.pinned) onUnpinDone();
    else if (futureTask) onPinDone();
    else onSetProgress(visual!.done ? "none" : "done");
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
        height: Math.max(0, visual.height - 2),
        background: visual.bg,
        border: `${visual.borderWidth}px ${visual.borderStyle} ${visual.border}`,
        borderRadius: 8,
        padding: `${compact ? 2 : visual.density === "medium" ? 3 : 6}px 8px`,
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
        <button
          onClick={handleCheckClick}
          title={visual.done ? "Mark not done" : "Mark done"}
          style={{
            position: "absolute",
            top: compact ? 1 : 3,
            right: 3,
            width: checkSize,
            height: checkSize,
            borderRadius: "50%",
            border: `1px solid ${visual.done ? "#9184d9" : "rgba(233,233,237,0.4)"}`,
            background: visual.done ? "#9184d9" : "rgba(22,24,38,0.6)",
            color: visual.done ? "#161826" : "#e9e9ed",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            zIndex: 2,
          }}
        >
          <CheckIcon size={9} weight="bold" />
        </button>
      )}

      {visual.density === "full" && (
        <>
          <div style={{ fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.7, lineHeight: 1 }}>
            {visual.tagLabel}
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              lineHeight: 1.25,
              marginTop: 2,
              color: visual.textColor,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {visual.title}
          </div>
          <div style={{ fontSize: 9.5, opacity: 0.65, marginTop: 2 }}>{visual.timeLabel}</div>
          {visual.statusLabel && (
            <div style={{ fontSize: 9, color: visual.statusColor, marginTop: 2, fontWeight: 600, letterSpacing: "0.05em" }}>
              {visual.statusLabel}
            </div>
          )}
        </>
      )}
      {(visual.density === "medium" || visual.density === "compact") && (
        // Not enough height to stack tag/title/time — the tag moves to a
        // vertical strip on the left instead of getting dropped, so every
        // block still shows its category, name, and time.
        <div style={{ display: "flex", height: "100%", alignItems: "flex-start", gap: 5 }}>
          <div
            style={{
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              fontSize: 7,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              opacity: 0.7,
              flex: "0 0 auto",
              lineHeight: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              // Aligned to the block's top edge (not centered) so a label
              // taller than the block truncates its tail end ("BLOC") —
              // centering would clip evenly from both ends and mangle the
              // start of the word too ("LOCK").
              maxHeight: "100%",
            }}
          >
            {visual.tagLabel}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div
              style={{
                fontSize: visual.density === "medium" ? 11 : 10,
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
            <div
              style={{
                fontSize: visual.density === "medium" ? 9 : 8.5,
                opacity: 0.65,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {visual.timeLabel}
            </div>
            {visual.statusLabel && visual.density === "medium" && (
              <div style={{ fontSize: 8.5, color: visual.statusColor, marginTop: 1, fontWeight: 600, letterSpacing: "0.05em" }}>
                {visual.statusLabel}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
