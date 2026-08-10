"use client";

// The chat rail's LAYOUT state — how wide it is, and whether it's collapsed.
//
// This lived inside PlannerChatPanel, which was right while the panel was a
// self-contained column. It isn't any more: the calendar page now lays its two
// sides out as one grid so their headers share a row and a single bottom border
// (a header wraps to two lines at some widths and one at others, and two
// independent columns could only ever agree by coincidence). The grid's column
// track IS the rail's width, so the page has to know it.
//
// Kept as a hook rather than props threaded through the panel because the panel
// still owns the CONTROLS — the collapse button and the drag handle live in its
// chrome — while the page owns the track they resize.

import { useEffect, useState } from "react";

const MIN_WIDTH = 300;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 400;
const WIDTH_KEY = "planner-panel-width";

/** Width of the collapsed rail — just wide enough for the expand button. */
export const COLLAPSED_WIDTH = 36;

/** Width of the drag handle between the two sides. */
export const HANDLE_WIDTH = 10;

/** The calendar's floor: below about this the hour gutter plus a few day columns
 * stop being readable however much they scale. The chat gives width back rather
 * than pushing the calendar under it. */
const CALENDAR_MIN = 560;

/** The panel is a fixed pixel width, so on a narrow window a width that was
 * comfortable on a wide one would squeeze the calendar to nothing. Clamping
 * against the viewport makes the two sides give way to each other instead: widen
 * the window and the chat can grow again, narrow it and the chat yields first. */
function clampWidth(want: number, viewportWidth: number): number {
  const ceiling = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - CALENDAR_MIN));
  return Math.min(ceiling, Math.max(MIN_WIDTH, want));
}

export interface ChatRail {
  width: number;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Drag the rail's left edge to trade calendar width for chat width. */
  startWidthResize: (e: React.PointerEvent<HTMLElement>) => void;
  /** Double-click the handle to go back to the default width. */
  resetWidth: () => void;
}

export function useChatRail(): ChatRail {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    const wanted = stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWidth(clampWidth(wanted, window.innerWidth));

    // Re-clamp as the window changes, so the pair stay in proportion rather than
    // the calendar being crushed by a width chosen on a bigger screen. The
    // stored preference is left alone — it's what to return to when there's room.
    const onResize = () => setWidth((w) => clampWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function startWidthResize(e: React.PointerEvent<HTMLElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      // Dragging left (smaller clientX) widens the panel.
      setWidth(clampWidth(startW + (startX - ev.clientX), window.innerWidth));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((w) => {
        window.localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return {
    width,
    collapsed,
    setCollapsed,
    startWidthResize,
    resetWidth: () => setWidth(clampWidth(DEFAULT_WIDTH, window.innerWidth)),
  };
}
