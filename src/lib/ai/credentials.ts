import { createAdminClient } from "@/lib/supabase/server";

export type ResolvedProvider = "user_api_key" | "subscription_oauth";

export type CredentialResult = { ok: true; provider: ResolvedProvider; secret: string } | { ok: false };

export const NO_CREDENTIAL_MESSAGE =
  "Add your own Anthropic API key in Settings to use the assistant or planner — see the instructions there.";

/** Resolves which Anthropic credential a request should run on.
 *
 * Every signed-in user — including the deployment's owner — must have their
 * own planner_credentials row; there is no shared/env-var fallback for
 * anyone. One key, entered once, covers both the assistant and the planner.
 * This is deliberate: it removes any way for one account's usage to bill to
 * someone else's key, even by accident. */
export async function resolvePlannerCredential(userId: string): Promise<CredentialResult> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("planner_credentials")
    .select("provider,secret")
    .eq("user_id", userId)
    .maybeSingle();

  if (data?.provider === "api_key") return { ok: true, provider: "user_api_key", secret: data.secret };
  if (data?.provider === "oauth_token") return { ok: true, provider: "subscription_oauth", secret: data.secret };
  return { ok: false };
}

/** Same as resolvePlannerCredential, but for the quick assistant, which only
 * ever calls the Anthropic API directly — a subscription_oauth row (Agent
 * SDK credential) can't be used here, so it's treated as no credential. */
export async function resolveAssistantCredential(userId: string): Promise<CredentialResult> {
  const result = await resolvePlannerCredential(userId);
  if (result.ok && result.provider === "subscription_oauth") return { ok: false };
  return result;
}
