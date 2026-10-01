// Ported from zkasuran/overhear (MiniMax Week, 2026-08) lib/episode.ts — added a brace-depth
// ceiling (MAX_JSON_BRACE_DEPTH) so a hostile input cannot drive deep recursion in JSON.parse,
// and widened the contract: this function throws only Error (never a raw SyntaxError leak) on any
// input, which the property test in extractJson.test.ts asserts over random bytes.

import { MAX_JSON_BRACE_DEPTH } from "./ceilings.js";

/**
 * Take the first complete, brace-balanced JSON object from model output. The model
 * sometimes wraps it in a code fence or adds a trailing sentence, so lastIndexOf("}")
 * is not safe. Returns the parsed value or throws an Error.
 */
export function extractJson(raw: string): unknown {
  if (typeof raw !== "string") throw new Error("extractJson: input is not a string");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced && fenced[1] !== undefined ? fenced[1] : raw;
  const start = body.indexOf("{");
  if (start === -1) throw new Error("model did not return JSON");

  let depth = 0;
  let maxDepth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      if (maxDepth > MAX_JSON_BRACE_DEPTH) throw new Error("JSON nesting too deep");
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch (e) {
          throw new Error(
            `model returned malformed JSON: ${e instanceof Error ? e.message : "parse error"}`,
          );
        }
      }
    }
  }
  throw new Error("model returned incomplete JSON");
}
