import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/** null = not yet checked. Cached so the warning logs at most once. */
let vapidReady: boolean | null = null;

/** Push notifications are optional, so their keys must not be required at
 * module load: configuring them eagerly threw during the production build's
 * page-data collection, which meant a fresh clone couldn't even build without
 * generating VAPID keys first. Configure on first send instead, and degrade to
 * "no push" rather than failing the request. */
function vapidConfigured(): boolean {
  if (vapidReady !== null) return vapidReady;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) {
    console.warn("[push] VAPID keys not configured — skipping push notifications.");
    vapidReady = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidReady = true;
  } catch (err) {
    console.error("[push] invalid VAPID configuration:", err instanceof Error ? err.message : err);
    vapidReady = false;
  }
  return vapidReady;
}

/** Sends to every device the user has subscribed on. Opportunistically
 * prunes subscriptions the push service reports as gone (uninstalled app,
 * cleared browser storage, etc.) rather than erroring on them. */
export async function sendPushToUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  payload: { title: string; body: string; url?: string },
): Promise<boolean> {
  if (!vapidConfigured()) return false;
  const { data: subs } = await supabase.from("push_subscriptions").select("*").eq("user_id", userId);
  if (!subs?.length) return false;

  let anySent = false;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          JSON.stringify(payload),
        );
        anySent = true;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        const body = (err as { body?: string }).body;
        console.error(`[push] send failed sub=${sub.id} status=${statusCode} body=${body} err=${err}`);
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }
      }
    }),
  );
  return anySent;
}
