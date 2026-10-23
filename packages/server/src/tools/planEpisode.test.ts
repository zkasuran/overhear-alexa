// plan_episode: it persists the planned episode and returns the outline, and it refuses past the quota.

import { describe, it, expect, afterEach } from "vitest";
import { runPlanEpisode } from "./planEpisode.js";
import { SpeculativeRegistry } from "../tasks.js";
import type { TaskEnv } from "../tasks.js";
import { EPISODES_PER_DAY, FORMAT_IDS, layoutLines, partDurationMs } from "@overhear/core";
import type { Episode, FormatId, Part, Speaker } from "@overhear/core";
import type { Config, EpisodeStore, Logger, Services } from "../contracts.js";

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

function makeConfig(): Config {
  const voices = {} as Record<FormatId, Record<Speaker, string>>;
  for (const f of FORMAT_IDS) voices[f] = { host: `${f}-host`, expert: `${f}-expert` };
  return {
    modelsMode: "mock",
    storeMode: "local",
    region: "us-east-1",
    bedrock: { planModelId: "p", scriptModelId: "s" },
    text: { provider: "bedrock", baseUrl: "", model: "", keyFile: "" },
    voices,
    s3Bucket: "",
    tables: { episodes: "e", tasks: "t", events: "v" },
    bind: { host: "127.0.0.1", port: 8787 },
    bindPublic: false,
    originAllowlist: [],
    tokenFile: "fixtures/test-token",
    mediaDir: ".media",
    dataDir: ".data",
    bedsDir: "assets/beds",
    presignTtlSeconds: 900,
  };
}

function makeStore(): EpisodeStore & {
  episodes: Map<string, Episode>;
  countSince: { value: number };
} {
  const episodes = new Map<string, Episode>();
  const sources = new Map<string, string>();
  const countSince = { value: 0 };
  const key = (p: string, id: string): string => `${p}::${id}`;
  const store = {
    episodes,
    countSince,
    async createEpisode(ep: Episode, sourceText: string) {
      episodes.set(key(ep.principal, ep.id), structuredClone(ep));
      sources.set(key(ep.principal, ep.id), sourceText);
    },
    async getEpisode(p: string, id: string) {
      return episodes.get(key(p, id)) ?? null;
    },
    async getSource(p: string, id: string) {
      return sources.get(key(p, id)) ?? null;
    },
    async putPart(p: string, id: string, part: Part) {
      const ep = episodes.get(key(p, id));
      if (ep === undefined) return;
      ep.parts = ep.parts.map((x) => (x.partId === part.partId ? structuredClone(part) : x));
    },
    async patchEpisode() {},
    async listByPrincipal() {
      return [];
    },
    async countEpisodesSince() {
      return countSince.value;
    },
    async close() {},
  };
  return store;
}

function makeServices(store: EpisodeStore): Services {
  return {
    config: makeConfig(),
    log: noopLogger,
    model: {
      id: "fake",
      async generate(messages) {
        if (messages.user.includes("Return JSON with exactly this shape")) {
          return JSON.stringify({
            title: "The Fed decision explained",
            dek: "A quick two voice look at the cut.",
            parts: [
              { heading: "Cold open", summary: "Set the scene.", estSeconds: 20 },
              { heading: "The cut", summary: "What they did.", estSeconds: 90 },
              { heading: "What next", summary: "Where it goes.", estSeconds: 60 },
            ],
          });
        }
        return JSON.stringify({
          lines: [
            { speaker: "host", text: "Here is the question." },
            { speaker: "expert", text: "Here is the answer." },
          ],
        });
      },
    },
    tts: {
      async synthesize(text: string) {
        const len = 100 + text.length;
        return { audio: new Uint8Array(len), seconds: len / 1000, mime: "audio/mpeg" as const };
      },
    },
    storage: {
      async putAudio(episodeId: string, partId: string) {
        return `key/${episodeId}/${partId}`;
      },
      async urlFor(k: string) {
        return `https://media.test/${k}`;
      },
    },
    mixer: {
      async mix({ lines, gapMs }) {
        const durationsMs = lines.map((l) => l.audio.length);
        const lineTimings = layoutLines(durationsMs, gapMs);
        let total = 0;
        for (const l of lines) total += l.audio.length;
        return {
          mp3: new Uint8Array(total),
          seconds: partDurationMs(lineTimings) / 1000,
          lineTimings,
        };
      },
    },
    fetch: {
      async fetchUrl(url: string) {
        return { text: "fetched text", contentType: "text/plain", finalUrl: url };
      },
    },
    episodes: store,
    now: () => 1_700_000_000_000,
  };
}

let activeEnv: TaskEnv | undefined;
let lastEpisodeId: string | undefined;
afterEach(() => {
  if (activeEnv !== undefined && lastEpisodeId !== undefined)
    activeEnv.speculative.cancel(lastEpisodeId);
});

function makeEnv(store: EpisodeStore): TaskEnv {
  const env: TaskEnv = {
    services: makeServices(store),
    log: noopLogger,
    sendProgress: async () => {},
    notifyResource: async () => {},
    speculative: new SpeculativeRegistry(),
  };
  activeEnv = env;
  return env;
}

describe("runPlanEpisode", () => {
  it("persists the planned episode and returns the outline", async () => {
    const store = makeStore();
    const env = makeEnv(store);
    const result = await runPlanEpisode(env, "user-1", {
      source: { kind: "topic", value: "The Fed decision" },
      format: "explainer",
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      episodeId: string;
      parts: unknown[];
      totalEstSeconds: number;
      speakable: string;
    };
    lastEpisodeId = sc.episodeId;
    expect(sc.episodeId.startsWith("ep_")).toBe(true);
    expect(sc.parts).toHaveLength(3);
    expect(sc.totalEstSeconds).toBeGreaterThan(0);
    expect(sc.speakable.length).toBeGreaterThan(0);

    const persisted = await store.getEpisode("user-1", sc.episodeId);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("planned");
    expect(persisted?.parts).toHaveLength(3);
  });

  it("refuses once the daily quota is reached", async () => {
    const store = makeStore();
    store.countSince.value = EPISODES_PER_DAY;
    const env = makeEnv(store);
    const result = await runPlanEpisode(env, "user-1", {
      source: { kind: "topic", value: "Anything" },
      format: "explainer",
    });
    expect(result.isError).toBe(true);
  });
});
