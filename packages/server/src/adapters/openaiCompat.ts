// Text model behind any OpenAI-compatible chat completions endpoint (GMI Cloud by default). It is a
// second provider for the same ModelAdapter seam the Bedrock adapter fills, selected only when a live
// run sets OVERHEAR_TEXT=openai. The API key is read once from a file (OVERHEAR_OPENAI_KEY_FILE), never
// from argv or an env value, so it cannot leak into a process listing or a log. Speech still goes to
// Amazon Polly; only the script writing moves.

import { readFileSync } from "node:fs";
import { MODEL_TIMEOUT_MS } from "@overhear/core";
import type { PromptMessages } from "@overhear/core";
import type { Logger, ModelAdapter, ModelCallOpts } from "../contracts.js";

/** Cap on the response body we will parse, so a hostile or broken endpoint cannot exhaust memory. */
export const MAX_COMPLETION_BYTES = 1_000_000;

export interface OpenAiCompatOptions {
  baseUrl: string; // e.g. https://api.gmi-serving.com/v1
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch; // injectable for tests
}

/** Read the API key from a file; the first non-empty line, trimmed. Throws a plain error if missing. */
export function readKeyFile(path: string): string {
  const line = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) throw new Error(`no API key found in ${path}`);
  return line;
}

interface ChatChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

export function makeOpenAiCompatModel(opts: OpenAiCompatOptions, log: Logger): ModelAdapter {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const doFetch = opts.fetchImpl ?? fetch;
  const logger = log.child({ adapter: "openai-compat", model: opts.model });

  return {
    id: opts.model,
    async generate(messages: PromptMessages, callOpts?: ModelCallOpts): Promise<string> {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
      };
      if (callOpts?.maxTokens !== undefined) body.max_tokens = callOpts.maxTokens;
      if (callOpts?.temperature !== undefined) body.temperature = callOpts.temperature;

      const timeoutMs = callOpts?.timeoutMs ?? MODEL_TIMEOUT_MS;
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (callOpts?.signal) signals.push(callOpts.signal);

      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        });
        const raw = await res.text();
        if (raw.length > MAX_COMPLETION_BYTES) throw new Error("completion body over the size cap");
        if (!res.ok) throw new Error(`chat completions returned HTTP ${res.status}`);
        const parsed = JSON.parse(raw) as { choices?: ChatChoice[] };
        const content = parsed.choices?.[0]?.message?.content;
        const text = typeof content === "string" ? content : "";
        if (text.length === 0) {
          logger.warn("chat completions returned no text", {
            finish: String(parsed.choices?.[0]?.finish_reason ?? ""),
          });
        }
        return text;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error("chat completions failed", { message: error.message });
        throw error;
      }
    },
  };
}
