"use client";

// Asking "are you sure?" in the app's own voice.
//
// Every destructive action used to go through the browser's `confirm()`. It
// worked, and it was the wrong tool for exactly the moments that matter most:
//
//   - It renders as an OS alert with the page's URL at the top, which reads as
//     something the browser is warning you about rather than a decision your
//     schedule is asking you to make.
//   - It cannot show structure. The whole point of counting what a delete will
//     take ("14 items, 3 with booked hours") is that you can scan it, and
//     `confirm()` gets one run-on string with \n in it.
//   - It cannot style the dangerous button differently from the safe one, so
//     "Empty Trash" and "OK" look identical.
//   - `prompt()` for type-to-confirm is worse still: a bare OS text field with no
//     indication of what happens if you get it wrong.
//
// Shaped as a hook returning [element, ask] rather than a context provider,
// because the call sites want to stay one-liners:
//
//     const [dialog, ask] = useConfirmDialog();
//     if (!(await ask({ title: "…", lines: […] }))) return;
//     return (<>{dialog}…</>);
//
// The promise resolves false on cancel, Escape, or a backdrop click — every exit
// that isn't a deliberate confirm.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

export interface ConfirmRequest {
  title: string;
  /** Rendered as a bulleted list under the title. Use for consequences. */
  lines?: string[];
  /** A closing sentence: what is reversible, where it goes, what to expect. */
  footnote?: string;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Red button and a heavier border. For anything that can't be undone. */
  danger?: boolean;
  /** When set, the confirm button stays disabled until this exact word is typed.
   * Reserved for the genuinely irreversible — a dialog that cries wolf trains
   * people to type the word without reading it. */
  typeToConfirm?: string;
}

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

export function useConfirmDialog(): [ReactElement | null, (req: ConfirmRequest) => Promise<boolean>] {
  const [pending, setPending] = useState<Pending | null>(null);
  const [typed, setTyped] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ask = useCallback((req: ConfirmRequest) => {
    setTyped("");
    return new Promise<boolean>((resolve) => setPending({ ...req, resolve }));
  }, []);

  const close = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
      setTyped("");
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    // Focus lands on the SAFE control when the action is dangerous, so a stray
    // Enter cannot destroy anything.
    if (pending.typeToConfirm) inputRef.current?.focus();
    else if (!pending.danger) confirmRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  if (!pending) return [null, ask];

  const satisfied = !pending.typeToConfirm || typed === pending.typeToConfirm;

  const element = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Cancel"
        onClick={() => close(false)}
        className="absolute inset-0 cursor-default"
        style={{ background: "rgba(0,0,0,0.5)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-[380px] rounded-lg border bg-panel p-4 flex flex-col gap-3"
        style={{ borderColor: pending.danger ? "#e5484d55" : "var(--color-border)" }}
      >
        <div className="text-[13px] text-text leading-snug">{pending.title}</div>

        {!!pending.lines?.length && (
          <ul className="flex flex-col gap-1">
            {pending.lines.map((line) => (
              <li key={line} className="text-[11.5px] text-muted leading-snug flex gap-1.5">
                <span className="text-muted-2">•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}

        {pending.footnote && <div className="text-[11px] text-muted-2 leading-relaxed">{pending.footnote}</div>}

        {pending.typeToConfirm && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">
              Type <span className="font-mono text-text">{pending.typeToConfirm}</span> to confirm
            </label>
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && satisfied) close(true);
              }}
              className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-text outline-none focus-visible:border-accent"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={() => close(false)}
            className="rounded-md border border-border px-2.5 py-1 text-[11.5px] text-text hover:bg-surface"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={() => close(true)}
            disabled={!satisfied}
            className="rounded-md border px-2.5 py-1 text-[11.5px] disabled:opacity-40"
            style={
              pending.danger
                ? { borderColor: "#e5484d", color: "#e5484d" }
                : { borderColor: "var(--color-accent)", color: "var(--color-accent-text)" }
            }
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );

  return [element, ask];
}
