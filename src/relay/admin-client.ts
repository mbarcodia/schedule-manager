// Deliberately standalone — does NOT import src/lib/supabase/server.ts,
// which also exports a cookie-based client depending on next/headers. The
// relay runs outside any Next.js request context (a plain Node process on
// Fly.io), so this keeps its dependency graph free of any doubt about
// Next.js internals working correctly there.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export function createRelayAdminClient() {
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
