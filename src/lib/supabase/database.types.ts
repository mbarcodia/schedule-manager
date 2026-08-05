// Hand-written to match supabase/migrations/0001_init.sql. If the schema
// changes, update this alongside it (or regenerate later with
// `supabase gen types typescript` once the project is linked via the CLI).

export type PreferredModel = "claude-haiku-4-5" | "claude-sonnet-5" | "claude-opus-4-8";
export type PlannerModel = "claude-sonnet-5" | "claude-opus-4-8" | "claude-fable-5";
export type PlannerCredentialProvider = "api_key" | "oauth_token";
export type NoteKind = "idea" | "todo" | "paper" | "update" | "other";
export type Priority = "high" | "medium" | "low";
export type TaskTimeOfDay = "morning" | "afternoon";
/** Whether a date is externally imposed or self-set. Scheduling treats them
 * identically; the consequence of missing one differs. */
export type DateKind = "hard" | "goal";
/** Where in the day a label's work belongs (categories.time_pref). The pair of
 * directions times the pair of strictnesses the engine can enforce: "*_only"
 * refuses the other half of the day outright, "prefer_*" tries it first and
 * falls back rather than leaving the work unscheduled. Null = any time. */
export type LabelTimePref = "prefer_morning" | "morning_only" | "prefer_afternoon" | "afternoon_only";
export type EventSource = "manual" | "google" | "icloud" | "outlook";
export type SubjectType = "task" | "research" | "anchor";
export type ChatRole = "user" | "assistant";
export type CalendarProvider = "outlook_ics" | "icloud_ics" | "google_ics";
/** What a connected calendar's all-day events are allowed to block. */
export type AllDayMode = "ignore" | "no_meetings" | "away";
/** How often a to-do list chases whatever is still unfinished in it. */
export type ChaseCadence = "week" | "month" | "year";

/** Keys are "0".."6" (0=Mon..6=Sun). null = day off by default. */
export type WeeklyHoursJson = Record<string, { start: number; end: number } | null>;

/** booking_links.day_windows — same shape/convention as WeeklyHoursJson;
 * null (or missing key) = that weekday not bookable. */
export type BookingDayWindowsJson = WeeklyHoursJson;

/** Where a booked meeting happens. 'zoom' uses the owner's static meeting
 * room URL, 'office' their office_location text. */
export type BookingLocationMode = "zoom" | "office";
export type BookingStatus = "confirmed" | "cancelled";

// Supabase's client generics require every table to carry a `Relationships`
// array (used for typed joins) and the schema to declare Views/Functions —
// even empty, since @supabase/postgrest-js's GenericTable/GenericSchema
// constraints require the shape to be present or the client's generic
// resolution silently falls back (surfaces as `never` types on writes).
interface Table<Row, Insert, Update> {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
}

export interface Database {
  public: {
    Tables: {
      profiles: Table<
        {
          id: string;
          preferred_model: PreferredModel;
          planner_model: PlannerModel;
          timezone: string;
          weekly_hours: WeeklyHoursJson;
          eod_checkin_enabled: boolean;
          eod_checkin_time: number;
          weekly_summary_enabled: boolean;
          weekly_summary_dow: number;
          weekly_summary_time: number;
          created_at: string;
          booking_meeting_url: string | null;
          display_name: string | null;
          office_location: string | null;
          grace_hours: number;
        },
        { id: string } & Partial<{
          preferred_model: PreferredModel;
          planner_model: PlannerModel;
          timezone: string;
          weekly_hours: WeeklyHoursJson;
          eod_checkin_enabled: boolean;
          eod_checkin_time: number;
          weekly_summary_enabled: boolean;
          weekly_summary_dow: number;
          weekly_summary_time: number;
          booking_meeting_url: string | null;
          display_name: string | null;
          office_location: string | null;
          grace_hours: number;
        }>,
        Partial<{
          preferred_model: PreferredModel;
          planner_model: PlannerModel;
          timezone: string;
          weekly_hours: WeeklyHoursJson;
          eod_checkin_enabled: boolean;
          eod_checkin_time: number;
          weekly_summary_enabled: boolean;
          weekly_summary_dow: number;
          weekly_summary_time: number;
          booking_meeting_url: string | null;
          display_name: string | null;
          office_location: string | null;
          grace_hours: number;
        }>
      >;
      categories: Table<
        {
          id: string;
          user_id: string;
          name: string;
          color: string;
          sort_order: number;
          created_at: string;
          min_chunk_min: number | null;
          time_pref: LabelTimePref | null;
          weekly_target_pct: number | null;
        },
        {
          id?: string;
          user_id: string;
          name: string;
          color: string;
          sort_order?: number;
          min_chunk_min?: number | null;
          time_pref?: LabelTimePref | null;
          weekly_target_pct?: number | null;
        },
        Partial<{
          name: string;
          color: string;
          sort_order: number;
          min_chunk_min: number | null;
          time_pref: LabelTimePref | null;
          weekly_target_pct: number | null;
        }>
      >;
      /** Projects. Still named `projects` in the database so that every
       * existing foreign key kept working when proposals and goals folded in
       * — see supabase/migrations/0023_projects_and_targets.sql. */
      projects: Table<
        {
          id: string;
          user_id: string;
          title: string;
          deadline_date: string | null;
          weekly_min_min: number | null;
          prefer_morning: boolean;
          chunk_min: number;
          research_ord: number | null;
          category_id: string | null;
          cadence: string | null;
          active_from: string | null;
          active_until: string | null;
          time_of_day: TaskTimeOfDay | null;
          effort_estimate_min: number | null;
          important: boolean;
          deadline_kind: DateKind;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          title: string;
          deadline_date?: string | null;
          weekly_min_min?: number | null;
          prefer_morning?: boolean;
          chunk_min?: number;
          research_ord?: number | null;
          category_id?: string | null;
          cadence?: string | null;
          active_from?: string | null;
          active_until?: string | null;
          time_of_day?: TaskTimeOfDay | null;
          effort_estimate_min?: number | null;
          important?: boolean;
          deadline_kind?: DateKind;
        },
        Partial<{
          title: string;
          deadline_date: string | null;
          weekly_min_min: number | null;
          prefer_morning: boolean;
          chunk_min: number;
          research_ord: number | null;
          category_id: string | null;
          cadence: string | null;
          active_from: string | null;
          active_until: string | null;
          time_of_day: TaskTimeOfDay | null;
          effort_estimate_min: number | null;
          important: boolean;
          deadline_kind: DateKind;
        }>
      >;
      /** A dated checkpoint inside a project that consumes no hours. */
      targets: Table<
        {
          id: string;
          user_id: string;
          commitment_id: string;
          title: string;
          target_date: string;
          completed_at: string | null;
          date_kind: DateKind;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          commitment_id: string;
          title: string;
          target_date: string;
          completed_at?: string | null;
          date_kind?: DateKind;
        },
        Partial<{ title: string; target_date: string; completed_at: string | null; date_kind: DateKind }>
      >;
      tasks: Table<
        {
          id: string;
          user_id: string;
          title: string;
          priority: Priority;
          duration_min: number;
          chunk_min: number;
          depends_on: string | null;
          deadline_at: string | null;
          deadline_all_day: boolean;
          floor_at: string;
          max_per_day_min: number | null;
          project_id: string | null;
          category_id: string | null;
          ord: number;
          created_at: string;
          pinned_date: string | null;
          pinned_start_min: number | null;
          pinned_length_min: number | null;
          time_of_day: TaskTimeOfDay | null;
          important: boolean;
          archived_at: string | null;
        },
        {
          id?: string;
          user_id: string;
          title: string;
          priority?: Priority;
          duration_min: number;
          chunk_min: number;
          depends_on?: string | null;
          deadline_at?: string | null;
          deadline_all_day?: boolean;
          floor_at?: string;
          max_per_day_min?: number | null;
          project_id?: string | null;
          category_id?: string | null;
          ord?: number;
          pinned_date?: string | null;
          pinned_start_min?: number | null;
          pinned_length_min?: number | null;
          time_of_day?: TaskTimeOfDay | null;
          important?: boolean;
          archived_at?: string | null;
        },
        Partial<{
          title: string;
          priority: Priority;
          duration_min: number;
          chunk_min: number;
          depends_on: string | null;
          deadline_at: string | null;
          deadline_all_day: boolean;
          floor_at: string;
          max_per_day_min: number | null;
          project_id: string | null;
          category_id: string | null;
          ord: number;
          pinned_date: string | null;
          pinned_start_min: number | null;
          pinned_length_min: number | null;
          time_of_day: TaskTimeOfDay | null;
          important: boolean;
          archived_at: string | null;
        }>
      >;
      recurring_rules: Table<
        {
          id: string;
          user_id: string;
          title: string;
          tag: string | null;
          days: number[];
          length_min: number;
          win_start_min: number | null;
          win_end_min: number | null;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          title: string;
          tag?: string | null;
          days?: number[];
          length_min: number;
          win_start_min?: number | null;
          win_end_min?: number | null;
        },
        Partial<{
          title: string;
          tag: string | null;
          days: number[];
          length_min: number;
          win_start_min: number | null;
          win_end_min: number | null;
        }>
      >;
      preference_notes: Table<
        { id: string; user_id: string; note: string; created_at: string },
        { id?: string; user_id: string; note: string },
        Partial<{ note: string }>
      >;
      notes: Table<
        {
          id: string;
          user_id: string;
          project_id: string | null;
          task_id: string | null;
          title: string;
          content: string;
          kind: NoteKind;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          user_id: string;
          project_id?: string | null;
          task_id?: string | null;
          title: string;
          content?: string;
          kind?: NoteKind;
        },
        Partial<{
          project_id: string | null;
          task_id: string | null;
          title: string;
          content: string;
          kind: NoteKind;
          updated_at: string;
        }>
      >;
      planner_messages: Table<
        { id: string; user_id: string; role: ChatRole; content: string; created_at: string },
        { id?: string; user_id: string; role: ChatRole; content: string },
        Partial<{ content: string }>
      >;
      // RLS-locked to the service role only (see 0011 migration) — never
      // queried from a browser/user-scoped client, only createAdminClient().
      planner_credentials: Table<
        { user_id: string; provider: PlannerCredentialProvider; secret: string; created_at: string },
        { user_id: string; provider: PlannerCredentialProvider; secret: string },
        Partial<{ provider: PlannerCredentialProvider; secret: string }>
      >;
      day_overrides: Table<
        {
          id: string;
          user_id: string;
          override_date: string;
          start_min: number | null;
          end_min: number | null;
          allow_weekend: boolean;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          override_date: string;
          start_min?: number | null;
          end_min?: number | null;
          allow_weekend?: boolean;
        },
        Partial<{ start_min: number | null; end_min: number | null; allow_weekend: boolean }>
      >;
      events: Table<
        {
          id: string;
          user_id: string;
          title: string;
          starts_at: string;
          ends_at: string;
          source: EventSource;
          all_day: boolean;
          external_id: string | null;
          connection_id: string | null;
          description: string | null;
          location: string | null;
          meeting_url: string | null;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          title: string;
          starts_at: string;
          ends_at: string;
          source?: EventSource;
          all_day?: boolean;
          external_id?: string | null;
          connection_id?: string | null;
          description?: string | null;
          location?: string | null;
          meeting_url?: string | null;
        },
        Partial<{ title: string; starts_at: string; ends_at: string }>
      >;
      calendar_connections: Table<
        {
          id: string;
          user_id: string;
          provider: CalendarProvider;
          label: string;
          ics_url: string;
          color: string;
          all_day_mode: AllDayMode;
          last_synced_at: string | null;
          last_sync_error: string | null;
          last_sync_event_count: number | null;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          provider: CalendarProvider;
          label: string;
          ics_url: string;
          color?: string;
          all_day_mode?: AllDayMode;
          last_synced_at?: string | null;
          last_sync_error?: string | null;
          last_sync_event_count?: number | null;
        },
        Partial<{
          label: string;
          ics_url: string;
          color: string;
          all_day_mode: AllDayMode;
          last_synced_at: string | null;
          last_sync_error: string | null;
          last_sync_event_count: number | null;
        }>
      >;
      push_subscriptions: Table<
        { id: string; user_id: string; endpoint: string; p256dh: string; auth_key: string; created_at: string },
        { id?: string; user_id: string; endpoint: string; p256dh: string; auth_key: string },
        Partial<{ endpoint: string; p256dh: string; auth_key: string }>
      >;
      progress_log: Table<
        {
          id: string;
          user_id: string;
          subject_type: SubjectType;
          subject_id: string;
          occurred_date: string;
          start_min: number;
          end_min: number;
          minutes_done: number | null;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          subject_type: SubjectType;
          subject_id: string;
          occurred_date: string;
          start_min: number;
          end_min: number;
          minutes_done?: number | null;
        },
        Partial<{ minutes_done: number | null }>
      >;
      pinned_chunks: Table<
        {
          id: string;
          user_id: string;
          subject_type: SubjectType;
          subject_id: string;
          tag_label: string | null;
          title: string;
          project_id: string | null;
          priority: Priority | null;
          occurred_date: string;
          start_min: number;
          end_min: number;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          subject_type: SubjectType;
          subject_id: string;
          tag_label: string | null;
          title: string;
          project_id?: string | null;
          priority?: Priority | null;
          occurred_date: string;
          start_min: number;
          end_min: number;
        },
        Record<string, never>
      >;
      chat_messages: Table<
        {
          id: string;
          user_id: string;
          role: ChatRole;
          content: string;
          created_at: string;
        },
        { id?: string; user_id: string; role: ChatRole; content: string },
        Record<string, never>
      >;
      todo_lists: Table<
        {
          id: string;
          user_id: string;
          name: string;
          chase: ChaseCadence | null;
          last_chased_at: string | null;
          show_completed: boolean;
          sort_order: number;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          name: string;
          chase?: ChaseCadence | null;
          show_completed?: boolean;
          sort_order?: number;
        },
        Partial<{
          name: string;
          chase: ChaseCadence | null;
          last_chased_at: string | null;
          show_completed: boolean;
          sort_order: number;
        }>
      >;
      todo_items: Table<
        {
          id: string;
          user_id: string;
          list_id: string;
          text: string;
          done: boolean;
          completed_at: string | null;
          due_at: string | null;
          due_all_day: boolean;
          lead_minutes: number[];
          sent_leads: number[];
          notes: string | null;
          hidden: boolean;
          task_id: string | null;
          event_id: string | null;
          sort_order: number;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          list_id: string;
          text: string;
          done?: boolean;
          due_at?: string | null;
          due_all_day?: boolean;
          lead_minutes?: number[];
          sent_leads?: number[];
          notes?: string | null;
          sort_order?: number;
        },
        Partial<{
          text: string;
          done: boolean;
          completed_at: string | null;
          due_at: string | null;
          due_all_day: boolean;
          lead_minutes: number[];
          sent_leads: number[];
          notes: string | null;
          hidden: boolean;
          task_id: string | null;
          event_id: string | null;
          sort_order: number;
          list_id: string;
        }>
      >;
      /** The Lists tab: things you're keeping track of, never scheduled. */
      lists: Table<
        {
          id: string;
          user_id: string;
          title: string;
          body: string;
          show_completed: boolean;
          sort_order: number;
          created_at: string;
        },
        { id?: string; user_id: string; title: string; body?: string; sort_order?: number },
        Partial<{ title: string; body: string; show_completed: boolean; sort_order: number }>
      >;
      list_items: Table<
        {
          id: string;
          user_id: string;
          list_id: string;
          text: string;
          done: boolean;
          completed_at: string | null;
          hidden: boolean;
          sort_order: number;
          created_at: string;
        },
        { id?: string; user_id: string; list_id: string; text: string; done?: boolean; sort_order?: number },
        Partial<{ text: string; done: boolean; completed_at: string | null; hidden: boolean; sort_order: number }>
      >;
      reminders: Table<
        {
          id: string;
          user_id: string;
          heading: string | null;
          title: string;
          due_at: string;
          notes: string | null;
          lead_minutes: number[];
          sent_leads: number[];
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          heading?: string | null;
          title: string;
          due_at: string;
          notes?: string | null;
          lead_minutes?: number[];
          sent_leads?: number[];
        },
        Partial<{
          heading: string | null;
          title: string;
          due_at: string;
          notes: string | null;
          lead_minutes: number[];
          sent_leads: number[];
        }>
      >;
      research_pins: Table<
        {
          id: string;
          user_id: string;
          project_id: string;
          pinned_date: string;
          start_min: number;
          length_min: number;
          created_at: string;
        },
        { id?: string; user_id: string; project_id: string; pinned_date: string; start_min: number; length_min: number },
        Partial<{ pinned_date: string; start_min: number; length_min: number }>
      >;
      google_credentials: Table<
        {
          user_id: string;
          google_email: string;
          refresh_token: string;
          needs_reconnect: boolean;
          created_at: string;
        },
        { user_id: string; google_email: string; refresh_token: string; needs_reconnect?: boolean },
        Partial<{ google_email: string; refresh_token: string; needs_reconnect: boolean }>
      >;
      booking_links: Table<
        {
          id: string;
          user_id: string;
          slug: string;
          title: string;
          durations: number[];
          day_windows: BookingDayWindowsJson;
          blocking_category_ids: string[];
          buffer_min: number;
          min_notice_hours: number;
          max_per_day: number | null;
          active: boolean;
          location_modes: BookingLocationMode[];
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          slug: string;
          title: string;
          durations?: number[];
          day_windows?: BookingDayWindowsJson;
          blocking_category_ids?: string[];
          buffer_min?: number;
          min_notice_hours?: number;
          max_per_day?: number | null;
          active?: boolean;
          location_modes?: BookingLocationMode[];
        },
        Partial<{
          slug: string;
          title: string;
          durations: number[];
          day_windows: BookingDayWindowsJson;
          blocking_category_ids: string[];
          buffer_min: number;
          min_notice_hours: number;
          max_per_day: number | null;
          active: boolean;
          location_modes: BookingLocationMode[];
        }>
      >;
      bookings: Table<
        {
          id: string;
          user_id: string;
          link_id: string;
          event_id: string | null;
          google_event_id: string | null;
          starts_at: string;
          ends_at: string;
          duration_min: number;
          visitor_name: string;
          visitor_email: string;
          visitor_note: string | null;
          location_mode: BookingLocationMode;
          status: BookingStatus;
          cancelled_at: string | null;
          last_changed_by: "owner" | "visitor" | null;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          link_id: string;
          event_id?: string | null;
          google_event_id?: string | null;
          starts_at: string;
          ends_at: string;
          duration_min: number;
          visitor_name: string;
          visitor_email: string;
          visitor_note?: string | null;
          location_mode?: BookingLocationMode;
        },
        Partial<{
          google_event_id: string | null;
          event_id: string | null;
          starts_at: string;
          ends_at: string;
          duration_min: number;
          location_mode: BookingLocationMode;
          status: BookingStatus;
          cancelled_at: string | null;
          last_changed_by: "owner" | "visitor" | null;
        }>
      >;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
