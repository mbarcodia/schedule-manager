import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

/** Supabase client for use in Server Components, Route Handlers, and Server
 * Actions. Create a new one per request — never share across requests. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component (no response to write to) —
            // middleware handles session refresh in that case instead.
          }
        },
      },
    },
  );
}

/** Server-only client using the secret key — bypasses Row Level Security.
 * Never expose this to the browser; only use it for privileged operations
 * (e.g. the chat assistant's tool execution runs as the authenticated user
 * via createClient() above, not this one, unless a specific action truly
 * needs to bypass RLS). */
export function createAdminClient() {
  return createSupabaseJsClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
