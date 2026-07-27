import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { computeFreeSlots } from "@/lib/scheduling/free-slots";

// PUBLIC route (middleware-exempt): everything here runs on the service-role
// client scoped by slug. The response contains ONLY free instants and the
// link's own metadata — never event titles, categories, or any owner data.

const querySchema = z.object({
  duration: z.coerce.number().int().positive(),
  week: z.coerce.number().int().min(0).max(11),
});

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    duration: url.searchParams.get("duration"),
    week: url.searchParams.get("week"),
  });
  if (!parsed.success) return NextResponse.json({ error: "Invalid query" }, { status: 400 });

  const admin = createAdminClient();
  const { data: link } = await admin.from("booking_links").select("*").eq("slug", slug).eq("active", true).maybeSingle();
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!link.durations.includes(parsed.data.duration)) {
    return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
  }

  const { slots, timezone } = await computeFreeSlots(admin, link, parsed.data.duration, parsed.data.week);
  return NextResponse.json({ slots, ownerTimezone: timezone, durations: link.durations, title: link.title });
}
