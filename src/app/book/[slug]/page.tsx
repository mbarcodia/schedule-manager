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
    .select("title,durations,location_modes,user_id")
    .eq("slug", slug)
    .eq("active", true)
    .maybeSingle();
  if (!link) notFound();

  // Office location is safe to show publicly; the meeting-room URL is not —
  // guests receive that with their invitation instead.
  const { data: profile } = await admin
    .from("profiles")
    .select("office_location,display_name")
    .eq("id", link.user_id)
    .single();

  return (
    <BookingClient
      slug={slug}
      title={link.title}
      durations={link.durations}
      locationModes={link.location_modes}
      officeLocation={profile?.office_location ?? null}
      ownerName={profile?.display_name ?? null}
    />
  );
}
