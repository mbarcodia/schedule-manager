// Pure view-model helpers for rendering a computed ScheduleBlock — ported
// from the prototype's renderVals() block-mapping (Schedule Manager.dc.html
// ~1124-1182): geometry, color-by-priority, compact/medium/full content
// thresholds, and status labeling. No React here — keeps the visual rules
// testable independent of the component tree.

import { fmtMin, minToLabel } from "./time";
import type { Category, ScheduleBlock } from "./types";

// The grid renders the full day so scrolling can reach any hour even when
// nothing's scheduled there — WeekGrid scrolls to DEFAULT_SCROLL_MIN on
// mount so the typical working window is what's visible by default.
export const DAY_START_MIN = 0; // midnight
export const DAY_END_MIN = 1440; // midnight next day
export const DEFAULT_SCROLL_MIN = 420; // 7:00am
export const PX_PER_MIN = 1; // 60px/hour

export type ContentDensity = "compact" | "medium" | "full";

export interface BlockVisual {
  top: number;
  height: number;
  bg: string;
  border: string;
  borderStyle: "solid" | "dashed";
  borderWidth: number;
  textColor: string;
  opacity: number;
  density: ContentDensity;
  tagLabel: string;
  title: string;
  timeLabel: string;
  statusLabel: string | null;
  statusColor: string;
  isTask: boolean;
  canComplete: boolean;
  done: boolean;
  isPastDeadline: boolean;
  isNearDeadline: boolean;
  tooltip: string;
  /** Which connected calendar a synced meeting came from — rendered as a
   * left edge accent bar rather than recoloring the whole block (that
   * treatment is reserved for task categories). Null/undefined = no bar. */
  accentColor?: string | null;
}

/** Derives a bg/border/text triplet from a single stored category color via
 * CSS color-mix — avoids hand-rolling hex math for what's essentially "a
 * muted fill, the pure color as border, a lightened text tone". */
function categoryPalette(hex: string): { bg: string; border: string; textColor: string } {
  return {
    bg: `color-mix(in srgb, ${hex} 32%, #232532)`,
    border: hex,
    textColor: `color-mix(in srgb, ${hex} 55%, #f5f4ff)`,
  };
}

const UNCATEGORIZED_PALETTE = { bg: "#292b31", border: "#75798c", textColor: "#cfd3e5" };

export interface BlockLane {
  lane: number;
  lanes: number;
}

/** Interval-partitions one day's *synced calendar events* into side-by-side
 * lanes so two real meetings at the same time split the column width
 * instead of stacking on top of each other. Deliberately scoped to
 * type==="synced" only — anchors and tasks are placed by the engine, which
 * guarantees they never overlap each other or an event; if one ever did,
 * laning it side-by-side would quietly hide a real scheduling bug instead
 * of surfacing it. Blocks with no Map entry (every non-synced block, and
 * any synced block with no overlap) render full-width via Block.tsx's
 * lane=0/lanes=1 fallback. */
export function computeBlockLanes(blocks: ScheduleBlock[]): Map<ScheduleBlock, BlockLane> {
  const out = new Map<ScheduleBlock, BlockLane>();
  const items = blocks
    .filter((b) => b.type === "synced")
    .map((b) => ({ b, start: Math.max(b.start, DAY_START_MIN), end: Math.min(b.end, DAY_END_MIN), lane: 0 }))
    .filter((x) => x.end > x.start)
    .sort((a, z) => a.start - z.start || z.end - a.end);

  let cluster: typeof items = [];
  let laneEnds: number[] = [];
  let clusterEnd = 0;

  const flush = () => {
    for (const x of cluster) out.set(x.b, { lane: x.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };

  for (const x of items) {
    if (cluster.length && x.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= x.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(x.end);
    } else {
      laneEnds[lane] = x.end;
    }
    x.lane = lane;
    cluster.push(x);
    clusterEnd = cluster.length === 1 ? x.end : Math.max(clusterEnd, x.end);
  }
  flush();
  return out;
}

export function computeBlockVisual(
  block: ScheduleBlock,
  opts: { atRiskTitles: string[]; nearDeadlineTitles?: string[]; categories?: Category[] },
): BlockVisual | null {
  const clampStart = Math.max(block.start, DAY_START_MIN);
  const clampEnd = Math.min(block.end, DAY_END_MIN);
  if (clampEnd <= clampStart) return null; // entirely outside the visible day span
  const height = (clampEnd - clampStart) * PX_PER_MIN;
  const density: ContentDensity = height < 40 ? "compact" : height < 64 ? "medium" : "full";

  let bg: string, border: string, textColor: string;
  if (block.type === "synced") {
    bg = "repeating-linear-gradient(135deg, #292b31 0, #292b31 4px, #232532 4px, #232532 8px)";
    border = "rgba(233,233,237,0.16)";
    textColor = "#cfd3e5";
  } else if (block.type === "anchor") {
    bg = "#292b31";
    border = "rgba(233,233,237,0.14)";
    textColor = "#e4e7f5";
  } else {
    // Category color is the block's main color now — priority still drives
    // scheduling order (see engine.ts), it just isn't the fill anymore.
    // Uncategorized tasks fall back to a neutral palette rather than the old
    // priority colors, since priority is no longer a visual dimension here.
    const category = block.categoryId ? opts.categories?.find((c) => c.id === block.categoryId) : null;
    const palette = category ? categoryPalette(category.color) : UNCATEGORIZED_PALETTE;
    bg = palette.bg;
    border = palette.border;
    textColor = palette.textColor;
  }

  const isTask = block.type === "task";
  // Deadline coloring only applies to not-yet-resolved future/active chunks —
  // once a chunk is done/partial/missed, its own status is more relevant.
  const isPastDeadline = isTask && !block.status && opts.atRiskTitles.includes(block.title);
  const isNearDeadline =
    isTask && !block.status && !isPastDeadline && (opts.nearDeadlineTitles ?? []).includes(block.title);
  const done = block.status === "done";
  const missed = block.status === "missed";
  const partial = block.status === "partial";
  const futureTask = isTask && !block.status;

  let statusLabel: string | null = null;
  let statusColor = "#9397ab";
  if (missed) {
    statusLabel = "MISSED";
    statusColor = "#d2cefd";
    bg = "#232532";
    textColor = "#9397ab";
  } else if (partial) {
    statusLabel = `${fmtMin(block.partMin ?? 0)} / ${fmtMin(block.end - block.start)} DONE`;
    statusColor = "#d2cefd";
  } else if (done) {
    statusLabel = "DONE";
    statusColor = "#9397ab";
  } else if (isPastDeadline) {
    statusLabel = "WILL MISS DEADLINE";
    statusColor = "#ffb4b6";
    border = "#e5484d";
  } else if (isNearDeadline) {
    statusLabel = "AT RISK";
    statusColor = "#ffd9a0";
    border = "#e0a94e";
  }

  const taskStarted = isTask && !!block.status && !block.pinned;
  const canComplete = isTask; // anchor check-circles are a deferred nice-to-have (see PROGRESS.md)

  const tooltip = missed
    ? `${block.title} — not completed, time moved later in the week`
    : partial
      ? `${block.title} — partially done, rest rescheduled`
      : done
        ? `${block.title} — done`
        : isPastDeadline
          ? `${block.title} — scheduled to finish after its deadline`
          : isNearDeadline
            ? `${block.title} — finishes the same day it's due, no buffer left`
            : taskStarted
              ? `${block.title} — click to log progress`
              : futureTask
                ? `${block.title} — check the circle to mark done early`
                : block.title;

  return {
    top: (clampStart - DAY_START_MIN) * PX_PER_MIN,
    height,
    bg,
    border,
    borderStyle: missed ? "dashed" : "solid",
    borderWidth: isPastDeadline || isNearDeadline ? 2 : 1,
    textColor,
    opacity: done ? 0.45 : missed ? 0.7 : partial ? 0.85 : 1,
    density,
    tagLabel: block.tagLabel,
    title: block.title,
    timeLabel: `${minToLabel(block.start)} – ${minToLabel(block.end)}`,
    statusLabel,
    statusColor,
    isTask,
    canComplete,
    done,
    isPastDeadline,
    isNearDeadline,
    tooltip,
    accentColor: block.type === "synced" ? block.connectionColor : null,
  };
}
