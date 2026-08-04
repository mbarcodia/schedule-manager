// Claude Agent SDK backend for planner turns — the subscription-token path.
// A user's Pro/Max plan only authenticates through Claude Code-shaped
// traffic (the CLAUDE_CODE_OAUTH_TOKEN env var, checked by the bundled CLI
// subprocess itself — see node_modules/@anthropic-ai/claude-agent-sdk),
// so this runs the same planner tools through query() instead of the
// Anthropic SDK's tool runner used by the API-key backends.
//
// This is a self-serve credential, not an embedded "Sign in with Claude"
// flow: a user runs `claude setup-token` themselves (Anthropic's own
// documented mechanism for personal CLI/script automation under a
// subscription) and pastes the resulting token here, the same way they'd
// paste an API key. See the Settings page copy for the exact instructions
// shown to users.

import { query, tool, createSdkMcpServer, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodTypeAny } from "zod";
import type { PlannerSystemPrompt, PlannerTurnInput } from "./run-turn";

/** The Agent SDK takes one system string and handles its own prompt caching
 * inside the Claude Code CLI, so the persona/context split (which exists to
 * place an explicit cache breakpoint on the direct-API path) collapses here. */
function flattenSystem(system: PlannerSystemPrompt): string {
  return `${system.persona}\n${system.context}`;
}

/** Every planner tool is built via betaTool() with a plain JSON-object
 * schema (see buildPlannerTools) — never one of the Anthropic-defined
 * built-in variants (memory, bash, computer-use, …) that also inhabit
 * BetaRunnableTool's public union type. Naming that narrower shape
 * directly avoids the union collapsing tool.run's parameter to `never`. */
/** One property of a tool's JSON Schema. `items` matters: an array property
 * whose items are ignored silently becomes a string (see below). */
interface JsonSchemaProp {
  type?: string;
  enum?: string[];
  description?: string;
  items?: { type?: string; enum?: string[] };
}

interface PlannerToolLike {
  name: string;
  description?: string;
  input_schema: { properties?: Record<string, JsonSchemaProp>; required?: string[] };
  run: (args: Record<string, unknown>) => Promise<string | Array<{ type: string; text?: string }>>;
}

/** Our tool schemas are flat JSON Schema objects (string/number/boolean
 * properties, string arrays, optional enums, an optional `required` list) — the
 * only shapes buildPlannerTools ever produces. The Agent SDK's tool()
 * requires a Zod raw shape, so this converts just that subset rather than
 * pulling in a general JSON-Schema-to-Zod library for one-off object
 * schemas we fully control ourselves.
 *
 * The array branch is not optional decoration. Without it an array property
 * fell through to z.string(), which made update_recurring's `days` impossible
 * to satisfy on this path: an array was rejected ("expected string, received
 * array") and a string was accepted and then crashed the tool body on
 * `inp.days.map is not a function`. The model retried formats until it gave up,
 * looking like model failure rather than a missing four-line branch. Any array
 * property added in future would have failed exactly the same way, so the
 * branch is keyed off the schema, not off `days`. */
function jsonSchemaToZodShape(schema: {
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}): Record<string, ZodTypeAny> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let field: ZodTypeAny;
    if (prop.enum) field = z.enum(prop.enum as [string, ...string[]]);
    else if (prop.type === "array") field = z.array(scalarFor(prop.items));
    else if (prop.type === "number") field = z.number();
    else if (prop.type === "boolean") field = z.boolean();
    else field = z.string();
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

/** Element type of an array property. Missing `items` means "some scalar" —
 * string is the safe read, and it's what every array in our schemas holds. */
function scalarFor(items: JsonSchemaProp["items"]): ZodTypeAny {
  if (items?.enum) return z.enum(items.enum as [string, ...string[]]);
  if (items?.type === "number") return z.number();
  if (items?.type === "boolean") return z.boolean();
  return z.string();
}

/** Adapts one of our betaTool()-shaped planner tools (name/description/
 * input_schema/run) into the Agent SDK's SdkMcpToolDefinition. */
function adaptTool(t: PlannerToolLike): SdkMcpToolDefinition {
  const shape = jsonSchemaToZodShape(t.input_schema);
  return tool(t.name, t.description ?? t.name, shape, async (args) => {
    const result = await t.run(args);
    const text = typeof result === "string" ? result : result.map((b) => b.text ?? "").join(" ");
    return { content: [{ type: "text", text }] };
  });
}

/** Shared by every Agent SDK call site (one-shot and persistent-session) so
 * the tool-adaptation logic above lives in exactly one place. */
export function buildPlannerMcpServer(tools: PlannerTurnInput["tools"]) {
  return createSdkMcpServer({
    name: "planner",
    tools: tools.map((t) => adaptTool(t as unknown as PlannerToolLike)),
  });
}

/** Env the Agent SDK subprocess should run with for a given user's
 * subscription token — never process.env directly (see below), and never
 * the app's own shared ANTHROPIC_API_KEY. Shared by every call site. */
export function buildPlannerSubprocessEnv(secret: string): Record<string, string | undefined> {
  // options.env REPLACES the subprocess environment entirely (it is not
  // merged with process.env) — build it explicitly per call so one user's
  // token can never leak into another's warm-lambda invocation, and so the
  // app's own shared ANTHROPIC_API_KEY never shadows the user's token.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = secret;
  return env;
}

/** Streaming variant: forwards each visible text delta to onChunk as the
 * model writes it, across every agentic iteration — the same contract as
 * runAnthropicTurnStream on the API-key path. Iterations that both produce
 * visible text get a paragraph break between them (same fix as the
 * anthropic-runner: without it "…summarizing.Here's the…" concatenates). */
export async function runAgentSdkTurnStream(
  input: PlannerTurnInput,
  onChunk: (text: string) => void,
): Promise<{ reply: string }> {
  const model = input.model === "claude-fable-5" ? "claude-opus-4-8" : input.model;
  const server = buildPlannerMcpServer(input.tools);
  const env = buildPlannerSubprocessEnv(input.secret);

  const prompt = input.history.length
    ? input.history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n")
    : "";

  let full = "";
  let resultReply: string | null = null;
  let failed = false;
  // Set at each message_start; consumed by the first text delta of that API
  // message so a break lands between iterations, not inside one.
  let pendingBreak = false;

  for await (const message of query({
    prompt,
    options: {
      env,
      model,
      systemPrompt: flattenSystem(input.system),
      tools: [],
      mcpServers: { planner: server },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: input.maxIterations,
      includePartialMessages: true,
    },
  })) {
    if (message.type === "stream_event" && message.parent_tool_use_id === null) {
      const event = message.event;
      if (event.type === "message_start") {
        pendingBreak = true;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
        if (pendingBreak && full && !full.endsWith("\n\n")) {
          full += "\n\n";
          onChunk("\n\n");
        }
        pendingBreak = false;
        full += event.delta.text;
        onChunk(event.delta.text);
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") resultReply = message.result || null;
      else failed = true;
    }
  }

  if (failed && !full.trim()) {
    const reply = "I couldn't reach the planner just now — nothing was changed. Please send that again.";
    onChunk(reply);
    return { reply };
  }
  // Deltas are the primary source; the result message is a fallback for the
  // (unobserved) case where a turn succeeds without emitting any deltas.
  return { reply: full.trim() || resultReply || "Done." };
}

export async function runAgentSdkTurn(input: PlannerTurnInput): Promise<{ reply: string }> {
  // The subscription plans this token authenticates don't include Fable 5 —
  // clamp defensively even though the settings picker should already keep
  // users off it while on this provider.
  const model = input.model === "claude-fable-5" ? "claude-opus-4-8" : input.model;
  const server = buildPlannerMcpServer(input.tools);
  const env = buildPlannerSubprocessEnv(input.secret);

  const prompt = input.history.length
    ? input.history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n")
    : "";

  let reply = "Done.";
  for await (const message of query({
    prompt,
    options: {
      env,
      model,
      systemPrompt: flattenSystem(input.system),
      tools: [], // disable every built-in tool (Bash, Read, Write, ...) — only our own MCP tools run
      mcpServers: { planner: server },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: input.maxIterations,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") reply = message.result || "Done.";
      else reply = "I couldn't reach the planner just now — nothing was changed. Please send that again.";
    }
  }
  return { reply };
}
