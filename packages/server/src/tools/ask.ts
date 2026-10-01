// ask (task, taskSupport optional). Answers a listener question grounded ONLY in the episode source and
// its transcript. Every quote the model returns is mapped to a {partId, lineId} by a verbatim substring
// match against the transcript lines; a quote that matches no line is dropped, never invented. When the
// model cannot ground the answer it sets grounded=false and the spoken answer says the episode did not
// cover it. The answer is voiced in the expert voice. Optional task: a client may call it without a task
// and the SDK blocks until it is done.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Citation, Episode } from "@overhear/core";
import {
  MODEL_TIMEOUT_MS,
  TTS_TIMEOUT_MS,
  askPrompt,
  extractJson,
  randomBase62,
} from "@overhear/core";
import { AskInput, AskModelOutput } from "../schemas.js";
import type { Services } from "../contracts.js";
import type { TaskEnv } from "../tasks.js";
import { createAndLaunch } from "../tasks.js";
import { ASK_OUTPUT } from "./outputs.js";
import { okResult, orderedParts, principalOf } from "./common.js";

export interface TranscriptLine {
  partId: string;
  lineId: string;
  text: string;
}

/** The ready-part lines in playback order, each with the ids a citation points at. */
export function collectTranscriptLines(episode: Episode): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const part of orderedParts(episode)) {
    if (part.status !== "ready" || part.lines === undefined) continue;
    for (const line of part.lines) {
      out.push({ partId: part.partId, lineId: line.lineId, text: line.text });
    }
  }
  return out;
}

/** Map each quote to the transcript line that contains it verbatim. Unmatched quotes are dropped. */
export function mapCitations(
  lines: readonly TranscriptLine[],
  quotes: readonly string[],
): Citation[] {
  const out: Citation[] = [];
  for (const quote of quotes) {
    const q = quote.trim();
    if (q.length === 0) continue;
    const line = lines.find((l) => l.text.includes(q));
    if (line === undefined) continue;
    out.push({ partId: line.partId, lineId: line.lineId, quote: q });
  }
  return out;
}

/** Core of ask, independent of the MCP wiring so it is unit-testable with fakes. */
export async function runAsk(
  services: Services,
  episode: Episode,
  input: { question: string },
): Promise<CallToolResult> {
  const lines = collectTranscriptLines(episode);
  const transcript = lines.map((l) => l.text).join("\n");
  const source = (await services.episodes.getSource(episode.principal, episode.id)) ?? "";

  const raw = await services.model.generate(
    askPrompt({ sourceText: source, transcript, question: input.question }),
    { timeoutMs: MODEL_TIMEOUT_MS },
  );
  const parsed = AskModelOutput.parse(extractJson(raw));

  const mapped = mapCitations(
    lines,
    parsed.citations.map((c) => c.quote),
  );
  // If the model claimed quotes but none match a real line, treat the answer as unsupported.
  const grounded = parsed.citations.length > 0 && mapped.length === 0 ? false : parsed.grounded;
  const citations = grounded ? mapped : [];

  const voiceId = services.config.voices[episode.format].expert;
  const synth = await services.tts.synthesize(parsed.answer, voiceId, {
    timeoutMs: TTS_TIMEOUT_MS,
  });
  const key = await services.storage.putAudio(episode.id, `ask_${randomBase62(16)}`, synth.audio);
  const url = await services.storage.urlFor(key);

  return okResult(
    {
      answer: parsed.answer,
      speaker: "expert",
      audio: { url, seconds: synth.seconds, mime: "audio/mpeg" },
      citations,
      grounded,
    },
    parsed.answer,
  );
}

/** Register ask on the server. */
export function registerAsk(server: McpServer, env: TaskEnv): void {
  const { services } = env;
  server.experimental.tasks.registerToolTask(
    "ask",
    {
      title: "Ask about the episode",
      description:
        "Answer a question grounded only in the source and the transcript, with citations.",
      inputSchema: AskInput.shape,
      outputSchema: ASK_OUTPUT,
      execution: { taskSupport: "optional" },
    },
    {
      createTask: async (args, extra) => {
        const principal = principalOf(extra);
        if (principal === undefined) throw new Error("This request is not authenticated.");
        const episode = await services.episodes.getEpisode(principal, args.episodeId);
        if (episode === null) throw new Error("I could not find that episode.");
        return createAndLaunch(env, extra, "Looking that up now.", extra._meta?.progressToken, () =>
          runAsk(services, episode, args),
        );
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );
}
