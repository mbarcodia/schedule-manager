// Client-side data fetch: pulls everything the engine needs for the signed-in
// user (Row Level Security scopes every query to them automatically) and
// converts it via buildScheduleInputs.

import { createClient } from "@/lib/supabase/client";
import { buildScheduleInputs, type RawScheduleRows } from "./from-db";
import { queryScheduleRows } from "./query-rows";
import type { Category, Project, ScheduleInputs, Target } from "./types";
import type { ProgressFacts } from "./logged-hours";

export interface ScheduleData {
  inputs: ScheduleInputs;
  projects: Project[];
  targets: Target[];
  categories: Category[];
  preferredModel: string;
  /** Raw task rows as stored — the board needs fields the engine's
   * transformed Task drops (important, archived_at, raw deadline_at,
   * project/proposal links). */
  rawTasks: RawScheduleRows["tasks"];
  /** Derived from the full work history: pace, estimate calibration and weekly
   * consistency all read from this. See logged-hours.ts. */
  progressFacts: ProgressFacts;
}

export async function fetchScheduleData(): Promise<ScheduleData> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  // The profile defaults to UTC at signup (the trigger has no way to know
  // the browser's zone). Sync it here so "now" — the now-line, missed/active
  // status — is computed against the account holder's real local time.
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data: currentProfile } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("id", user.id)
    .single();
  if (currentProfile && currentProfile.timezone !== detectedTz) {
    await supabase.from("profiles").update({ timezone: detectedTz }).eq("id", user.id);
  }

  const now = new Date();
  const rows = await queryScheduleRows(supabase, user.id, now);
  const { inputs, projects, targets, categories } = buildScheduleInputs(rows, now);
  return {
    inputs,
    projects,
    targets,
    categories,
    preferredModel: rows.profile.preferred_model,
    rawTasks: rows.tasks,
    progressFacts: rows.progressFacts ?? { byProject: {}, finished: [], logged: [] },
  };
}
