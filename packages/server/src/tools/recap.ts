// recap (task, taskSupport optional). Writes and voices a short recap in the host voice covering ONLY
// what has been heard: every part before the upTo point in full, plus the lines of the upTo part whose
// audio ends at or before the given offset. Nothing not already said is introduced. Optional task: a
// client may call it without a task and the SDK blocks until it is done.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Episode } from "@overhear/core";
import {
  MODEL_TIMEOUT_MS,
  TTS_TIMEOUT_MS,
  extractJson,
  randomBase62,
  recapPrompt,
} from "@overhear/core";
import { RecapInput, RecapModelOutput } from "../schemas.js";
import type { RecapInputT } from "../schemas.js";
import type { Services } from "../contracts.js";
import type { TaskEnv } from "../tasks.js";
import { createAndLaunch } from "../tasks.js";
import { RECAP_OUTPUT } from "./outputs.js";
import { okResult, orderedParts, principalOf, toolError } from "./common.js";

/** The transcript of what has been heard up to {partId, offsetMs}. Lines are relative to their part. */
export function heardTranscript(episode: Episode, upToPartId: string, offsetMs: number): string {
  const ordered = orderedParts(episode);
  let upToPos = ordered.findIndex((p) => p.partId === upToPartId);
  if (upToPos < 0) upToPos = ordered.length - 1;
  const chunks: string[] = [];
  for (let i = 0; i <= upToPos; i += 1) {
    const part = ordered[i];
    if (part === undefined || part.status !== "ready" || part.lines === undefined) continue;
    for (const line of part.lines) {
      const heard = i < upToPos || (line.endMs ?? Number.POSITIVE_INFINITY) <= offsetMs;
      if (heard) chunks.push(`${line.speaker}: ${line.text}`);
    }
  }
  return chunks.join("\n");
}

/** Core of recap, independent of the MCP wiring so it is unit-testable with fakes. */
export async function runRecap(
  services: Services,
  episode: Episode,
  input: RecapInputT,
): Promise<CallToolResult> {
  const transcript = heardTranscript(episode, input.upTo.partId, input.upTo.offsetMs);
  if (transcript.trim().length === 0) {
    return toolError("There is nothing to recap yet.");
  }
  const raw = await services.model.generate(
    recapPrompt({ transcriptUpTo: transcript, seconds: input.seconds }),
    { timeoutMs: MODEL_TIMEOUT_MS },
  );
  const parsed = RecapModelOutput.parse(extractJson(raw));

  const voiceId = services.config.voices[episode.format].host;
  const synth = await services.tts.synthesize(parsed.text, voiceId, { timeoutMs: TTS_TIMEOUT_MS });
  const key = await services.storage.putAudio(episode.id, `recap_${randomBase62(16)}`, synth.audio);
  const url = await services.storage.urlFor(key);

  return okResult(
    { text: parsed.text, audio: { url, seconds: synth.seconds, mime: "audio/mpeg" } },
    parsed.text,
  );
}

/** Register recap on the server. */
export function registerRecap(server: McpServer, env: TaskEnv): void {
  const { services } = env;
  server.experimental.tasks.registerToolTask(
    "recap",
    {
      title: "Recap so far",
      description: "A short spoken recap of what has been heard up to a point in the episode.",
      inputSchema: RecapInput.shape,
      outputSchema: RECAP_OUTPUT,
      execution: { taskSupport: "optional" },
    },
    {
      createTask: async (args, extra) => {
        const principal = principalOf(extra);
        if (principal === undefined) throw new Error("This request is not authenticated.");
        const episode = await services.episodes.getEpisode(principal, args.episodeId);
        if (episode === null) throw new Error("I could not find that episode.");
        return createAndLaunch(
          env,
          extra,
          "Putting together a recap now.",
          extra._meta?.progressToken,
          () => runRecap(services, episode, args),
        );
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );
}
