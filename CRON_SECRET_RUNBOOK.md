# Fixing a CRON_SECRET drift alert

You got this because the hourly `Notification digests` GitHub Actions workflow
got a non-200 from the cron routes — almost always a `CRON_SECRET` mismatch
between Vercel and GitHub Actions (see `project_cron_secret_drift_fixed` in
memory for the 2026-07-24 incident this replaces the silent-failure-email for).

## Fix

1. Pick the value to standardize on — usually whatever's in `web/.env.local`:
   ```bash
   cd web
   LOCAL_SECRET=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2- | tr -d '"')
   ```

2. Sync Vercel (Production + Preview):
   ```bash
   npx vercel env rm CRON_SECRET production --yes
   printf '%s' "$LOCAL_SECRET" | npx vercel env add CRON_SECRET production
   printf '%s' "$LOCAL_SECRET" | npx vercel env add CRON_SECRET preview
   ```

3. Sync the GitHub Actions secret:
   ```bash
   printf '%s' "$LOCAL_SECRET" | gh secret set CRON_SECRET --repo mbarcodia/schedule-manager
   ```

4. Redeploy prod so the env var change actually takes effect:
   ```bash
   npx vercel deploy --prod --yes
   ```

5. Verify:
   ```bash
   H=$(date -u +%-H)
   curl -s -o /dev/null -w "%{http_code}\n" \
     "https://schedule-manager-puce.vercel.app/api/cron/eod-checkin?hour=$H" \
     -H "Authorization: Bearer $LOCAL_SECRET"
   # should print 200
   gh workflow run digest-notifications.yml --repo mbarcodia/schedule-manager
   ```

## Why this keeps happening

`CRON_SECRET` is duplicated in three independent places (Vercel prod/preview
env, GitHub Actions secret, `.env.local`) with no automatic sync — a
deliberate choice to avoid storing a broad-access Vercel API token in GitHub
Actions (see conversation 2026-07-24). If you rotate it anywhere, update all
three, then redeploy.
