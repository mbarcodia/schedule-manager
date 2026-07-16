import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log("--- auth.users ---");
const { data: users, error: usersErr } = await admin.auth.admin.listUsers();
if (usersErr) console.log("ERROR:", usersErr);
else users.users.forEach((u) => console.log(u.id, u.email, "confirmed:", !!u.email_confirmed_at));

console.log("\n--- public.profiles ---");
const { data: profiles, error: profilesErr } = await admin.from("profiles").select("*");
if (profilesErr) console.log("ERROR:", profilesErr);
else console.log(profiles);
