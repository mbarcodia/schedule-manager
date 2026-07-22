import { createAdminClient } from "@/lib/supabase/server";

export type ResolvedProvider = "user_api_key" | "env_api_key" | "subscription_oauth";

export type CredentialResult = { ok: true; provider: ResolvedProvider; secret: string } | { ok: false };

export const NO_CREDENTIAL_MESSAGE =
  "This deployment's shared Anthropic key is reserved for its owner. Add your own Anthropic API key in Settings → Planner AI to use the assistant or planner.";

function isOwner(email: string | null | undefined): boolean {
  const ownerEmail = process.env.OWNER_EMAIL;
  return !!ownerEmail && !!email && email.toLowerCase() === ownerEmail.toLowerCase();
}

/** Resolves which Anthropic credential a request should run on.
 *
 * The shared env key (ANTHROPIC_API_KEY) is reserved for the deployment
 * owner (OWNER_EMAIL) only — every other signed-in user must have their own
 * planner_credentials row or the call is refused. There is deliberately no
 * fallback for non-owners: usage must never bill to the owner's account on
 * someone else's behalf, even by accident. */
export async function resolvePlannerCredential(
  userId: string,
  email: string | null | undefined,
): Promise<CredentialResult> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("planner_credentials")
    .select("provider,secret")
    .eq("user_id", userId)
    .maybeSingle();

  if (data?.provider === "api_key") return { ok: true, provider: "user_api_key", secret: data.secret };
  if (data?.provider === "oauth_token") return { ok: true, provider: "subscription_oauth", secret: data.secret };

  if (isOwner(email) && process.env.ANTHROPIC_API_KEY) {
    return { ok: true, provider: "env_api_key", secret: process.env.ANTHROPIC_API_KEY };
  }

  return { ok: false };
}

/** Same as resolvePlannerCredential, but for the quick assistant, which only
 * ever calls the Anthropic API directly — a subscription_oauth row (Agent
 * SDK credential) can't be used here, so it's treated as no credential. */
export async function resolveAssistantCredential(
  userId: string,
  email: string | null | undefined,
): Promise<CredentialResult> {
  const result = await resolvePlannerCredential(userId, email);
  if (result.ok && result.provider === "subscription_oauth") return { ok: false };
  return result;
}
