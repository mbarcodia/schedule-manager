// Standalone relay for subscription-token planner turns — deployed
// separately from the Next.js app (Fly.io) because the Claude Agent SDK's
// bundled CLI binary (~250-270MB per platform) doesn't fit in a Vercel
// serverless function. See the plan's Stage 3 section for the full
// rationale. This process does everything one planner turn needs — fetch
// schedule rows/notes/history, build the system prompt and tools, run the
// Agent SDK — using its own admin Supabase client. Vercel's role shrinks to
// authenticating the user and forwarding {userId, secret, model}.

import http from "node:http";
import { createRelayAdminClient } from "./admin-client";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { buildPlannerPersonaPrompt, buildPlannerDynamicContext } from "@/lib/planner/system-prompt";
import { DEFAULT_CHAT_MODE, isChatMode, modeInstruction, type ChatMode } from "@/lib/planner/modes";
import { buildPlannerTools } from "@/lib/planner/tools";
import { runAgentSdkTurn, runAgentSdkTurnStream } from "@/lib/planner/agent-runner";
import type { PlannerTurnInput } from "@/lib/planner/run-turn";
import { zonedNow } from "@/lib/scheduling/time";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const RELAY_SECRET = process.env.PLANNER_RELAY_SECRET;

if (!RELAY_SECRET) {
  console.error("PLANNER_RELAY_SECRET is not set — refusing to start.");
  process.exit(1);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

async function prepareTurnInput(userId: string, secret: string, model: string, mode: ChatMode): Promise<PlannerTurnInput> {
  const admin = createRelayAdminClient();

  const [rows, { data: noteRows }] = await Promise.all([
    queryScheduleRows(admin, userId),
    admin.from("notes").select("*").eq("user_id", userId).order("updated_at", { ascending: false }),
  ]);
  const { inputs } = buildScheduleInputs(rows);
  const schedule = computeSchedule(inputs);
  const systemPrompt = {
    persona: buildPlannerPersonaPrompt(),
    context: `${buildPlannerDynamicContext(rows, inputs, schedule, noteRows ?? [])}\n${modeInstruction(mode)}`,
  };

  const z = zonedNow(rows.profile.timezone);
  const today = new Date(z.year, z.month - 1, z.day);

  const tools = buildPlannerTools({
    supabase: admin,
    userId,
    timezone: rows.profile.timezone,
    weeklyHours: inputs.weeklyHours,
    horizonWeeks: inputs.horizonWeeks,
    today,
    rows,
    inputs,
    mutationTracker: { mutated: false },
  });

  const { data: historyRows } = await admin
    .from("planner_messages")
    .select("role,content")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(40);
  const history = (historyRows ?? [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    provider: "subscription_oauth",
    secret,
    model,
    system: systemPrompt,
    history,
    tools,
    maxIterations: 12,
  };
}

async function handleTurn(userId: string, secret: string, model: string, mode: ChatMode): Promise<{ reply: string }> {
  return runAgentSdkTurn(await prepareTurnInput(userId, secret, model, mode));
}

const server = http.createServer(async (req, res) => {
  // /turn returns the full reply as JSON once done; /turn-stream writes
  // plain-text chunks as the model produces them (chunked transfer). Both
  // stay available so relay and Vercel deploys never have to be atomic.
  const isStream = req.url === "/turn-stream";
  if (req.method !== "POST" || (req.url !== "/turn" && !isStream)) {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${RELAY_SECRET}`) {
    res.writeHead(401).end();
    return;
  }

  try {
    const body = (await readJsonBody(req)) as { userId?: string; secret?: string; model?: string; mode?: string };
    if (!body.userId || !body.secret || !body.model) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing userId/secret/model" }));
      return;
    }

    // Older callers omit mode; default rather than reject so a Vercel deploy
    // and a relay deploy don't have to land in the same instant.
    const mode: ChatMode = isChatMode(body.mode) ? body.mode : DEFAULT_CHAT_MODE;

    if (isStream) {
      const input = await prepareTurnInput(body.userId, body.secret, body.model, mode);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      try {
        await runAgentSdkTurnStream(input, (chunk) => res.write(chunk));
      } catch (err) {
        // Headers are already out — append a visible marker rather than
        // silently truncating what streamed so far.
        console.error("relay stream turn error", err);
        res.write("\n\nI hit an error partway through this reply — it may be incomplete. Please send that again.");
      }
      res.end();
      return;
    }

    const result = await handleTurn(body.userId, body.secret, body.model, mode);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  } catch (err) {
    console.error("relay turn error", err);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Turn failed" }));
  }
});

server.listen(PORT, () => {
  console.log(`planner relay listening on :${PORT}`);
});
