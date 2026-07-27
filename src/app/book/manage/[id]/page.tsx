import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/server";
import { ManageClient } from "./manage-client";

// PUBLIC page (middleware-exempt). The booking id is the capability — an
// unguessable uuid shared only with the guest and the owner.

export default async function ManageBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const admin = createAdminClient();
  const { data: booking } = await admin.from("bookings").select("id").eq("id", id).maybeSingle();
  if (!booking) notFound();

  return <ManageClient bookingId={id} />;
}
