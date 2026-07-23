-- Block tag labels (Task/Research/Deep focus/Block) were hardcoded strings
-- in the scheduling engine with no explanation anywhere in the app and no
-- way to rename them. Let each user customize what they're called; null
-- means "use the built-in default" so existing users see no change until
-- they actually set one.
alter table public.profiles
  add column label_task text,
  add column label_research text,
  add column label_deep_focus text,
  add column label_block text;
