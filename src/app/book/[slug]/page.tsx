import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/server";
import { BookingClient } from "./booking-client";

// PUBLIC page (middleware-exempt): the server component only confirms the
// link exists and passes its display metadata — everything else happens
// against the public /api/book routes.

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("booking_links")
    .select("title,durations")
    .eq("slug", slug)
    .eq("active", true)
    .maybeSingle();
  if (!link) notFound();

  return <BookingClient slug={slug} title={link.title} durations={link.durations} />;
}
