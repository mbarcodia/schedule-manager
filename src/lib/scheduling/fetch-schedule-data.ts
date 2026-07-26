// Client-side data fetch: pulls everything the engine needs for the signed-in
// user (Row Level Security scopes every query to them automatically) and
// converts it via buildScheduleInputs.

import { createClient } from "@/lib/supabase/client";
import { buildScheduleInputs, type RawScheduleRows } from "./from-db";
import { queryScheduleRows } from "./query-rows";
import type { Category, Goal, Project, Proposal, ScheduleInputs } from "./types";

export interface ScheduleData {
  inputs: ScheduleInputs;
  projects: Project[];
  proposals: Proposal[];
  goals: Goal[];
  categories: Category[];
  preferredModel: string;
  /** Raw task rows as stored — the board needs fields the engine's
   * transformed Task drops (important, archived_at, raw deadline_at,
   * project/proposal links). */
  rawTasks: RawScheduleRows["tasks"];
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
  const { inputs, projects, proposals, goals, categories } = buildScheduleInputs(rows, now);
  return {
    inputs,
    projects,
    proposals,
    goals,
    categories,
    preferredModel: rows.profile.preferred_model,
    rawTasks: rows.tasks,
  };
}
