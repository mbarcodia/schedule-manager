"use client";

import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";

interface KanbanColumnProps {
  id: string;
  title: string;
  count: number;
  /** Extra header line, e.g. "clears each week" on Done. */
  subtitle?: string;
  /** Warn styling on the header (WIP limit exceeded). */
  warn?: boolean;
  /** Right-aligned header badge, e.g. "4/3" WIP count. */
  badge?: string;
  children: ReactNode;
}

export function KanbanColumn({ id, title, count, subtitle, warn, badge, children }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className="flex-1 min-w-[180px] flex flex-col min-h-0 transition-colors"
      style={isOver ? { background: "rgba(145,132,217,0.05)" } : undefined}
    >
      <div
        className="flex-none px-2.5 py-2 border-b flex items-baseline justify-between gap-1.5"
        style={{ borderColor: warn ? "#e0a94e" : "var(--color-border)" }}
      >
        <div className="min-w-0">
          <span className="text-[10px] tracking-wide uppercase text-muted-2 font-medium">{title}</span>
          <span className="ml-1.5 text-[10px] text-muted">{count}</span>
          {subtitle && <div className="text-[9px] text-muted-2">{subtitle}</div>}
        </div>
        {badge && (
          <span
            className="flex-none text-[10px] font-semibold"
            style={{ color: warn ? "#e0a94e" : "var(--color-muted, #9397ab)" }}
          >
            {badge}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 py-2 flex flex-col gap-1.5 min-h-0">{children}</div>
    </div>
  );
}
