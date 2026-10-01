// Prompts: one per format, so a generic MCP client can discover the product without reading docs. Each
// expands to a single user message that instructs the model to call plan_episode with that format. The
// arguments are source (required) and minutes (optional); prompt arguments are strings on the wire, so
// minutes is parsed by the tool, not here.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FormatId } from "@overhear/core";
import { FORMATS } from "@overhear/core";
import type { Logger } from "./contracts.js";

const PROMPTS: ReadonlyArray<{ name: string; format: FormatId; description: string }> = [
  {
    name: "brief_me",
    format: "explainer",
    description: "Brief me on a topic as a curious explainer.",
  },
  {
    name: "debate_it",
    format: "debate",
    description: "Hear both sides of a topic as a fair debate.",
  },
  {
    name: "wind_down",
    format: "cozy",
    description: "Wind down with a calm, unhurried take on a topic.",
  },
  {
    name: "hype_it",
    format: "hype",
    description: "Turn a topic into a punchy, high-energy trailer.",
  },
];

/** The user message a prompt expands to. Tells the model which tool to call and with what format. */
export function promptMessage(format: FormatId, source: string, minutes?: string): string {
  const f = FORMATS[format];
  const length =
    minutes !== undefined && minutes.trim().length > 0
      ? ` Aim for about ${minutes.trim()} minutes.`
      : "";
  return `Make a two-host audio episode from this and read it to me. Call the plan_episode tool with format "${format}" (${f.label}, ${f.tone}).${length}\n\nSource:\n${source}`;
}

/** Register the four format prompts. The high-level prompt API carries no icon field (SEP-973), so the
 * prompt icons under docs/assets ship with the README rather than the prompts/list payload. */
export function registerPrompts(server: McpServer, log: Logger): void {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      {
        title: p.description,
        description: p.description,
        argsSchema: {
          source: z.string().min(1).describe("Topic, URL or text to turn into an episode."),
          minutes: z.string().optional().describe("Target length in minutes (2 to 15)."),
        },
      },
      (args) => {
        const minutes = args.minutes;
        const text =
          minutes !== undefined
            ? promptMessage(p.format, args.source, minutes)
            : promptMessage(p.format, args.source);
        return { messages: [{ role: "user", content: { type: "text", text } }] };
      },
    );
  }
  log.info("prompts registered", { count: PROMPTS.length });
}
