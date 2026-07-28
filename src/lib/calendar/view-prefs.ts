// How many days the calendar shows at once.
//
// Stored per device rather than on the profile on purpose: it describes the
// screen you're looking at, not the schedule. A laptop wants 7 days and a phone
// wants 1, and syncing that between them would be a bug, not a feature.

export const VIEW_DAY_OPTIONS = [1, 3, 5, 7] as const;
export type ViewDays = (typeof VIEW_DAY_OPTIONS)[number];

export const DEFAULT_VIEW_DAYS: ViewDays = 7;

const KEY = "calendar-view-days";
/** Lets the Settings control and an open calendar update each other live. */
const CHANGE_EVENT = "calendar-view-days-change";

function isViewDays(n: number): n is ViewDays {
  return (VIEW_DAY_OPTIONS as readonly number[]).includes(n);
}

export function readViewDays(): ViewDays {
  if (typeof window === "undefined") return DEFAULT_VIEW_DAYS;
  const stored = Number(window.localStorage.getItem(KEY));
  return isViewDays(stored) ? stored : DEFAULT_VIEW_DAYS;
}

export function writeViewDays(days: ViewDays): void {
  window.localStorage.setItem(KEY, String(days));
  window.dispatchEvent(new CustomEvent<ViewDays>(CHANGE_EVENT, { detail: days }));
}

/** Subscribe to changes from anywhere in the app (or another tab). */
export function onViewDaysChange(handler: (days: ViewDays) => void): () => void {
  const local = (e: Event) => handler((e as CustomEvent<ViewDays>).detail);
  const cross = (e: StorageEvent) => {
    if (e.key === KEY) handler(readViewDays());
  };
  window.addEventListener(CHANGE_EVENT, local);
  window.addEventListener("storage", cross);
  return () => {
    window.removeEventListener(CHANGE_EVENT, local);
    window.removeEventListener("storage", cross);
  };
}
