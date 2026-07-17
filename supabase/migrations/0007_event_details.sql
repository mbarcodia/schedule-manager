-- Carries meeting metadata through the ICS sync so a synced calendar block
-- can be expanded on click instead of requiring a switch back to Outlook/
-- iCloud/Google. meeting_url is auto-detected from the feed's own
-- description/location/url fields (Zoom/Meet/Teams/Webex/etc link) — same
-- trust boundary as everything else here (RLS-protected, never exposed
-- beyond the owning account), so this isn't new exposure, just more of the
-- same calendar content already being synced.
alter table public.events
  add column description text,
  add column location text,
  add column meeting_url text;
