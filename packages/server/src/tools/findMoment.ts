// find_moment (sync, taskSupport forbidden). Resolves natural language to a position in an episode. No
// audio is generated. Relative moves ("back 30 seconds", "next part", "skip this", "start over") are
// resolved deterministically with the core timeline math and never call the model; only a semantic query
// ("the history bit") calls the model with the outline. A read for a non-owner returns "not found".

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Part } from "@overhear/core";
import {
  MODEL_TIMEOUT_MS,
  clampOffsetMs,
  episodeOffsetsMs,
  extractJson,
  findMomentPrompt,
} from "@overhear/core";
import { FindModelOutput, FindMomentInput } from "../schemas.js";
import type { FindMomentInputT } from "../schemas.js";
import type { Services } from "../contracts.js";
import { okResult, orderedParts, partSeconds, principalOf, toolError } from "./common.js";

const FIND_OUTPUT_SHAPE = {
  partId: z.string(),
  index: z.number().int(),
  offsetMs: z.number().int(),
  heading: z.string(),
  confidence: z.number(),
  reason: z.string(),
};

export type Nav =
  | { kind: "seconds"; ms: number; direction: 1 | -1 }
  | { kind: "part"; direction: 1 | -1 }
  | { kind: "restart" };

export interface MomentResult {
  partId: string;
  index: number;
  offsetMs: number;
  heading: string;
  confidence: number;
  reason: string;
}

const ONES: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** A count from the query: digits first, then a small set of spelled numbers ("thirty", "forty five"). */
function extractNumber(q: string): number | undefined {
  const digits = q.match(/\d+/);
  if (digits !== null) return Number(digits[0]);
  let total = 0;
  let found = false;
  for (const token of q.replace(/-/g, " ").split(" ")) {
    if (token in TENS) {
      total += TENS[token] as number;
      found = true;
    } else if (token in ONES) {
      total += ONES[token] as number;
      found = true;
    }
  }
  return found ? total : undefined;
}

/** Classify a query as a deterministic move, or null when it needs the model. */
export function parseNav(query: string): Nav | null {
  const q = query.toLowerCase().trim().replace(/\s+/g, " ");

  const num = extractNumber(q);
  const unitMin = /\b(min|mins|minute|minutes)\b/.test(q);
  const unitSec = /\b(sec|secs|second|seconds)\b/.test(q);
  const dirBack = /\b(back|backward|backwards|rewind|rewound|earlier)\b/.test(q);
  const dirFwd = /\b(forward|forwards|ahead|skip|later)\b/.test(q);
  if (num !== undefined && (unitMin || unitSec) && (dirBack || dirFwd)) {
    return { kind: "seconds", ms: num * (unitMin ? 60_000 : 1_000), direction: dirBack ? -1 : 1 };
  }

  if (/^(go to |jump to |skip to )?(the )?next( part| section| bit| chapter| one)?$/.test(q)) {
    return { kind: "part", direction: 1 };
  }
  if (/^skip( this| it| ahead| this part| this one| this bit| this section)?$/.test(q)) {
    return { kind: "part", direction: 1 };
  }
  if (/^(go )?(back|backward|backwards|rewind)( a part| one part| one)?$/.test(q)) {
    return { kind: "part", direction: -1 };
  }
  if (/^(go to |jump to )?(the )?(previous|prior|last)( part| section| one)?$/.test(q)) {
    return { kind: "part", direction: -1 };
  }
  if (
    /^(restart|start over|start again|replay( it)?|again|the beginning|from the (start|beginning|top)|back to the (start|beginning))$/.test(
      q,
    )
  ) {
    return { kind: "restart" };
  }
  return null;
}

function lastIndexAtOrBefore(offsets: readonly number[], ms: number): number {
  let r = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const o = offsets[i];
    if (o !== undefined && o <= ms) r = i;
    else break;
  }
  return r;
}

/** Deterministic resolution of a relative move against the episode timeline. Pure. */
export function resolveRelative(
  parts: readonly Part[],
  nav: Nav,
  from?: { partId: string; offsetMs: number },
): MomentResult | null {
  if (parts.length === 0) return null;
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const offsets = episodeOffsetsMs(ordered.map(partSeconds));
  const partMs = ordered.map((p) => Math.round(partSeconds(p) * 1000));
  const lastIdx = ordered.length - 1;
  const totalMs = (offsets[lastIdx] ?? 0) + (partMs[lastIdx] ?? 0);

  let curIdx = 0;
  if (from !== undefined) {
    const i = ordered.findIndex((p) => p.partId === from.partId);
    if (i >= 0) curIdx = i;
  }
  const curOffset = from !== undefined ? clampOffsetMs(from.offsetMs, partMs[curIdx] ?? 0) : 0;

  const at = (idx: number, offsetMs: number, reason: string): MomentResult | null => {
    const p = ordered[idx];
    if (p === undefined) return null;
    return { partId: p.partId, index: idx, offsetMs, heading: p.heading, confidence: 1, reason };
  };

  if (nav.kind === "restart") return at(0, 0, "Starting from the beginning.");
  if (nav.kind === "part") {
    const target = Math.min(Math.max(curIdx + nav.direction, 0), lastIdx);
    return at(target, 0, nav.direction > 0 ? "Skipped to the next part." : "Went back a part.");
  }
  const absMs = (offsets[curIdx] ?? 0) + curOffset + nav.direction * nav.ms;
  const clamped = clampOffsetMs(absMs, totalMs);
  const target = lastIndexAtOrBefore(offsets, clamped);
  const offsetMs = clamped - (offsets[target] ?? 0);
  const seconds = Math.round(nav.ms / 1_000);
  return at(
    target,
    offsetMs,
    `Moved ${nav.direction < 0 ? "back" : "forward"} ${seconds} seconds.`,
  );
}

function momentResult(m: MomentResult): CallToolResult {
  return okResult(
    {
      partId: m.partId,
      index: m.index,
      offsetMs: m.offsetMs,
      heading: m.heading,
      confidence: m.confidence,
      reason: m.reason,
    },
    m.reason.length > 0 ? m.reason : `Taking you to "${m.heading}".`,
  );
}

/** Core of find_moment, independent of the MCP wiring so it is unit-testable with fakes. */
export async function runFindMoment(
  services: Services,
  principal: string,
  input: FindMomentInputT,
): Promise<CallToolResult> {
  const episode = await services.episodes.getEpisode(principal, input.episodeId);
  if (episode === null) return toolError("I could not find that episode.");

  const nav = parseNav(input.query);
  if (nav !== null) {
    const moment = resolveRelative(episode.parts, nav, input.from);
    if (moment === null) return toolError("That episode has no parts to move through yet.");
    return momentResult(moment);
  }

  const ordered = orderedParts(episode);
  const outline = ordered.map((p) => ({
    partId: p.partId,
    heading: p.heading,
    summary: p.summary,
  }));
  let parsed;
  try {
    const raw = await services.model.generate(findMomentPrompt({ outline, query: input.query }), {
      timeoutMs: MODEL_TIMEOUT_MS,
    });
    parsed = FindModelOutput.parse(extractJson(raw));
  } catch {
    return toolError("I could not work out which part you meant.");
  }
  const index = ordered.findIndex((p) => p.partId === parsed.partId);
  const part = index >= 0 ? ordered[index] : undefined;
  if (part === undefined) return toolError("I could not match that to a part of this episode.");
  return momentResult({
    partId: part.partId,
    index,
    offsetMs: 0,
    heading: part.heading,
    confidence: parsed.confidence,
    reason: parsed.reason,
  });
}

/** Register find_moment on the server. */
export function registerFindMoment(server: McpServer, services: Services): void {
  server.registerTool(
    "find_moment",
    {
      title: "Find a moment",
      description:
        'Resolve a spoken request like "back 30 seconds" or "the history bit" to a position.',
      inputSchema: FindMomentInput.shape,
      outputSchema: FIND_OUTPUT_SHAPE,
    },
    async (args, extra) => {
      const principal = principalOf(extra);
      if (principal === undefined) return toolError("This request is not authenticated.");
      return runFindMoment(services, principal, args);
    },
  );
}
