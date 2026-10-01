// Dependency assembly. Picks the mock or AWS twin of each adapter from the run mode and returns the
// Services bundle the pipeline and tool handlers receive. This is the only place that knows which
// concrete adapter is in play; everything downstream sees interfaces.
//
// Note: Services carries one `model`. We bind it to the script/expand model (the higher-quality one);
// plan_episode and find_moment also use it. A cheaper plan-model split is an AWS-only latency nicety,
// deferred so the frozen Services contract holds.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config, Logger, Services } from "../contracts.js";
import { makeBedrockModel } from "./bedrock.js";
import { makeMockModel } from "./mock/model.js";
import { makePollyTts } from "./polly.js";
import { makeMockTts } from "./mock/tts.js";
import { makeStorage } from "./storage.js";
import { makeFfmpegMixer } from "./ffmpeg.js";
import { makeFetchService } from "./fetch.js";
import { makeSqliteEpisodeStore } from "./episodeStore.sqlite.js";
import { makeDdbEpisodeStore } from "./episodeStore.ddb.js";

export { resolveMediaToken } from "./storage.js";

export function makeServices(config: Config, log: Logger): Services {
  const model =
    config.modelsMode === "aws"
      ? makeBedrockModel(config.bedrock.scriptModelId, config.region, log)
      : makeMockModel(log);

  const tts = config.modelsMode === "aws" ? makePollyTts(config.region, log) : makeMockTts();

  if (config.storeMode === "local") {
    mkdirSync(config.mediaDir, { recursive: true });
    mkdirSync(config.dataDir, { recursive: true });
  }

  const episodes =
    config.storeMode === "aws"
      ? makeDdbEpisodeStore(config, log)
      : makeSqliteEpisodeStore(join(config.dataDir, "overhear.sqlite"), log);

  return {
    config,
    log,
    model,
    tts,
    storage: makeStorage(config, log),
    fetch: makeFetchService(log),
    mixer: makeFfmpegMixer(log),
    episodes,
    now: () => Date.now(),
  };
}
