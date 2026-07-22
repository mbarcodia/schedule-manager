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
import type { PlannerTurnInput } from "./run-turn";

/** Every planner tool is built via betaTool() with a plain JSON-object
 * schema (see buildPlannerTools) — never one of the Anthropic-defined
 * built-in variants (memory, bash, computer-use, …) that also inhabit
 * BetaRunnableTool's public union type. Naming that narrower shape
 * directly avoids the union collapsing tool.run's parameter to `never`. */
interface PlannerToolLike {
  name: string;
  description?: string;
  input_schema: { properties?: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[] };
  run: (args: Record<string, unknown>) => Promise<string | Array<{ type: string; text?: string }>>;
}

/** Our tool schemas are flat JSON Schema objects (string/number/boolean
 * properties, optional string enums, an optional `required` list) — the
 * only shapes buildPlannerTools ever produces. The Agent SDK's tool()
 * requires a Zod raw shape, so this converts just that subset rather than
 * pulling in a general JSON-Schema-to-Zod library for one-off object
 * schemas we fully control ourselves. */
function jsonSchemaToZodShape(schema: {
  properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
  required?: string[];
}): Record<string, ZodTypeAny> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let field: ZodTypeAny;
    if (prop.enum) field = z.enum(prop.enum as [string, ...string[]]);
    else if (prop.type === "number") field = z.number();
    else if (prop.type === "boolean") field = z.boolean();
    else field = z.string();
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
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

export async function runAgentSdkTurn(input: PlannerTurnInput): Promise<{ reply: string }> {
  // The subscription plans this token authenticates don't include Fable 5 —
  // clamp defensively even though the settings picker should already keep
  // users off it while on this provider.
  const model = input.model === "claude-fable-5" ? "claude-opus-4-8" : input.model;

  const server = createSdkMcpServer({
    name: "planner",
    tools: input.tools.map((t) => adaptTool(t as unknown as PlannerToolLike)),
  });

  // options.env REPLACES the subprocess environment entirely (it is not
  // merged with process.env) — build it explicitly per call so one user's
  // token can never leak into another's warm-lambda invocation, and so the
  // app's own shared ANTHROPIC_API_KEY never shadows the user's token.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = input.secret;

  const prompt = input.history.length
    ? input.history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n")
    : "";

  let reply = "Done.";
  for await (const message of query({
    prompt,
    options: {
      env,
      model,
      systemPrompt: input.system,
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
