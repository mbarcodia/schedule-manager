// Hand-written to match supabase/migrations/0001_init.sql. If the schema
// changes, update this alongside it (or regenerate later with
// `supabase gen types typescript` once the project is linked via the CLI).

export type PreferredModel = "claude-haiku-4-5" | "claude-sonnet-5" | "claude-opus-4-8";
export type PlannerModel = "claude-sonnet-5" | "claude-opus-4-8" | "claude-fable-5";
export type PlannerCredentialProvider = "api_key" | "oauth_token";
export type NoteKind = "idea" | "todo" | "paper" | "update" | "other";
export type Priority = "high" | "medium" | "low";
export type TaskTag = "deep-focus" | "research";
export type EventSource = "manual" | "google" | "icloud" | "outlook";
export type SubjectType = "task" | "research";
export type ChatRole = "user" | "assistant";
export type CalendarProvider = "outlook_ics" | "icloud_ics" | "google_ics";

/** Keys are "0".."6" (0=Mon..6=Sun). null = day off by default. */
export type WeeklyHoursJson = Record<string, { start: number; end: number } | null>;

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
        }>
      >;
      categories: Table<
        { id: string; user_id: string; name: string; color: string; sort_order: number; created_at: string },
        { id?: string; user_id: string; name: string; color: string; sort_order?: number },
        Partial<{ name: string; color: string; sort_order: number }>
      >;
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
        },
        Partial<{
          title: string;
          deadline_date: string | null;
          weekly_min_min: number | null;
          prefer_morning: boolean;
          chunk_min: number;
          research_ord: number | null;
          category_id: string | null;
        }>
      >;
      proposals: Table<
        {
          id: string;
          user_id: string;
          title: string;
          deadline_date: string | null;
          created_at: string;
        },
        { id?: string; user_id: string; title: string; deadline_date?: string | null },
        Partial<{ title: string; deadline_date: string | null }>
      >;
      goals: Table<
        { id: string; user_id: string; title: string; cadence: string; created_at: string },
        { id?: string; user_id: string; title: string; cadence?: string },
        Partial<{ title: string; cadence: string }>
      >;
      tasks: Table<
        {
          id: string;
          user_id: string;
          title: string;
          priority: Priority;
          duration_min: number;
          chunk_min: number;
          tag: TaskTag | null;
          depends_on: string | null;
          deadline_at: string | null;
          floor_at: string;
          max_per_day_min: number | null;
          project_id: string | null;
          proposal_id: string | null;
          category_id: string | null;
          ord: number;
          created_at: string;
          pinned_date: string | null;
          pinned_start_min: number | null;
          pinned_length_min: number | null;
        },
        {
          id?: string;
          user_id: string;
          title: string;
          priority?: Priority;
          duration_min: number;
          chunk_min: number;
          tag?: TaskTag | null;
          depends_on?: string | null;
          deadline_at?: string | null;
          floor_at?: string;
          max_per_day_min?: number | null;
          project_id?: string | null;
          proposal_id?: string | null;
          category_id?: string | null;
          ord?: number;
          pinned_date?: string | null;
          pinned_start_min?: number | null;
          pinned_length_min?: number | null;
        },
        Partial<{
          title: string;
          priority: Priority;
          duration_min: number;
          chunk_min: number;
          tag: TaskTag | null;
          depends_on: string | null;
          deadline_at: string | null;
          floor_at: string;
          max_per_day_min: number | null;
          project_id: string | null;
          proposal_id: string | null;
          category_id: string | null;
          ord: number;
          pinned_date: string | null;
          pinned_start_min: number | null;
          pinned_length_min: number | null;
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
          proposal_id: string | null;
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
          proposal_id?: string | null;
          task_id?: string | null;
          title: string;
          content?: string;
          kind?: NoteKind;
        },
        Partial<{
          project_id: string | null;
          proposal_id: string | null;
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
          last_synced_at?: string | null;
          last_sync_error?: string | null;
          last_sync_event_count?: number | null;
        },
        Partial<{
          label: string;
          ics_url: string;
          color: string;
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
          tag_label: string;
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
          tag_label: string;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
