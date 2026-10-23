// Pipeline + scheduler tests with in-file fake adapters that implement the contracts interfaces. No
// concrete adapter is imported: the fakes are deterministic, so the walk through the statuses, the
// line timings and the strict playback order are all checkable without AWS or ffmpeg. The fake mixer
// derives each line duration from its audio byte length (1 byte == 1 ms here) and lays the timeline
// with core layoutLines, exactly as a real mixer reads durations from the audio it is handed.

import { describe, it, expect } from "vitest";
import { planEpisode, renderPart, expandPart } from "./pipeline.js";
import { renderEpisode } from "./scheduler.js";
import { renderFillers, pickFiller, FILLER_LINES, FILLERS_PER_FORMAT } from "./fillers.js";
import { FORMATS, FORMAT_IDS, layoutLines, partDurationMs } from "@overhear/core";
import type { Episode, Part, FormatId, Speaker } from "@overhear/core";
import type {
  Services,
  Config,
  Logger,
  ModelAdapter,
  TtsAdapter,
  StorageAdapter,
  Mixer,
  EpisodeStore,
  FetchService,
} from "../contracts.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PLAN_PARTS = [
  { heading: "Cold open", summary: "Set the scene fast.", estSeconds: 20 },
  { heading: "Slow middle", summary: "The hard part, worked through.", estSeconds: 90 },
  { heading: "Fast finish", summary: "Land the point and stop.", estSeconds: 300 },
];

function extractHeading(user: string): string {
  const m = user.match(/Write ONLY this part: "([^"]*)"/);
  return m && m[1] !== undefined ? m[1] : "part";
}

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child(_fields: Record<string, unknown>): Logger {
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
    bedrock: { planModelId: "mock-plan", scriptModelId: "mock-script" },
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

/** Deterministic model: schema-valid JSON per prompt type, with an optional per-heading script delay
 * so one part can be made slow to prove the scheduler stays serial. */
function makeModel(scriptDelayMs?: (heading: string) => number): ModelAdapter {
  return {
    id: "fake-model",
    async generate(messages) {
      const user = messages.user;
      if (user.includes("Return JSON with exactly this shape")) {
        return JSON.stringify({
          title: "The Fed decision explained",
          dek: "A quick two voice look at the cut and what it means next.",
          parts: PLAN_PARTS,
        });
      }
      if (user.includes('"heading":string, "lines"')) {
        return JSON.stringify({
          heading: "Deeper on the dissent",
          lines: [
            { speaker: "host", text: "So what did the dissenters actually want?" },
            { speaker: "expert", text: "A hold. They said so on the record." },
          ],
        });
      }
      const heading = extractHeading(user);
      const delay = scriptDelayMs ? scriptDelayMs(heading) : 0;
      if (delay > 0) await sleep(delay);
      return JSON.stringify({
        lines: [
          { speaker: "host", text: `[${heading}] here is the question.` },
          { speaker: "expert", text: `[${heading}] here is the answer.` },
          { speaker: "host", text: `[${heading}] and that is why it matters.` },
        ],
      });
    },
  };
}

/** Fixed bytes + seconds. Byte length encodes the duration (1 byte == 1 ms) so the mixer can read it
 * back the way ffmpeg reads a real stream. */
function makeTts(delayMs = 0): TtsAdapter {
  return {
    async synthesize(text) {
      if (delayMs > 0) await sleep(delayMs);
      const len = 100 + text.length;
      return { audio: new Uint8Array(len), seconds: len / 1000, mime: "audio/mpeg" };
    },
  };
}

function makeStorage(): StorageAdapter {
  return {
    async putAudio(episodeId, partId, _bytes) {
      return `key/${episodeId}/${partId}`;
    },
    async urlFor(key) {
      return `https://media.test/${key}`;
    },
  };
}

/** Concatenate the line audio, lay the timeline with core layoutLines from the per-line byte lengths. */
function makeMixer(): Mixer {
  return {
    async mix({ lines, gapMs }) {
      const durationsMs = lines.map((l) => l.audio.length);
      const lineTimings = layoutLines(durationsMs, gapMs);
      let total = 0;
      for (const l of lines) total += l.audio.length;
      const mp3 = new Uint8Array(total);
      let off = 0;
      for (const l of lines) {
        mp3.set(l.audio, off);
        off += l.audio.length;
      }
      return { mp3, seconds: partDurationMs(lineTimings) / 1000, lineTimings };
    },
  };
}

const fetchStub: FetchService = {
  async fetchUrl(url) {
    return { text: "", contentType: "text/plain", finalUrl: url };
  },
};

/** In-memory episode store with a parts map exposed for assertions. */
function makeStore(): { store: EpisodeStore; parts: Map<string, Part> } {
  const episodes = new Map<string, Episode>();
  const sources = new Map<string, string>();
  const parts = new Map<string, Part>();
  const key = (principal: string, id: string): string => `${principal}::${id}`;
  const store: EpisodeStore = {
    async createEpisode(ep, sourceText) {
      episodes.set(key(ep.principal, ep.id), structuredClone(ep));
      sources.set(key(ep.principal, ep.id), sourceText);
    },
    async getEpisode(principal, id) {
      return episodes.get(key(principal, id)) ?? null;
    },
    async getSource(principal, id) {
      return sources.get(key(principal, id)) ?? null;
    },
    async putPart(principal, id, part) {
      parts.set(`${key(principal, id)}::${part.partId}`, structuredClone(part));
    },
    async patchEpisode(principal, id, patch) {
      const ep = episodes.get(key(principal, id));
      if (ep !== undefined) episodes.set(key(principal, id), { ...ep, ...patch });
    },
    async listByPrincipal() {
      return [];
    },
    async countEpisodesSince() {
      return 0;
    },
    async close() {},
  };
  return { store, parts };
}

function makeServices(
  store: EpisodeStore,
  opts?: { scriptDelayMs?: (heading: string) => number; ttsDelayMs?: number },
): Services {
  return {
    config: makeConfig(),
    log: noopLogger,
    model: makeModel(opts?.scriptDelayMs),
    tts: makeTts(opts?.ttsDelayMs ?? 0),
    storage: makeStorage(),
    fetch: fetchStub,
    mixer: makeMixer(),
    episodes: store,
    now: () => 1_700_000_000_000,
  };
}

describe("planEpisode", () => {
  it("returns a planned episode with pending parts and clamped estimates", async () => {
    const { store } = makeStore();
    const services = makeServices(store);
    const episode = await planEpisode(services, {
      source: { kind: "topic", value: "The Fed decision" },
      format: "explainer",
      minutes: 6,
      principal: "user-1",
    });

    expect(episode.id.startsWith("ep_")).toBe(true);
    expect(episode.principal).toBe("user-1");
    expect(episode.format).toBe("explainer");
    expect(episode.status).toBe("planned");
    expect(episode.sourceKind).toBe("topic");
    expect(episode.targetSeconds).toBe(360);
    expect(episode.title.length).toBeGreaterThan(0);
    expect(episode.parts).toHaveLength(3);
    expect(episode.parts.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(episode.parts.every((p) => p.status === "pending")).toBe(true);
    expect(episode.parts.every((p) => p.origin === "plan")).toBe(true);
    expect(episode.parts.every((p) => p.partId.startsWith("pt_"))).toBe(true);
    // clamp to [PART0_TARGET_SECONDS, PART_MAX_SECONDS]: 20 -> 30, 90 stays, 300 -> 120.
    expect(episode.parts.map((p) => p.estSeconds)).toEqual([30, 90, 120]);
  });
});

describe("renderPart", () => {
  it("walks scripting -> voicing -> mixing -> ready and fills line timings", async () => {
    const { store } = makeStore();
    const services = makeServices(store);
    const episode = await planEpisode(services, {
      source: { kind: "topic", value: "The Fed decision" },
      format: "explainer",
      minutes: 6,
      principal: "user-1",
    });
    await store.createEpisode(episode, "Source text the handler stored before rendering.");

    const part0 = episode.parts[0];
    if (part0 === undefined) throw new Error("expected a first part");

    const statuses: string[] = [];
    const ready = await renderPart(services, episode, part0, "", (p) => {
      statuses.push(p.status);
    });

    expect(statuses).toEqual(["scripting", "voicing", "mixing", "ready"]);
    expect(ready.status).toBe("ready");
    expect(ready.audio?.mime).toBe("audio/mpeg");
    expect(ready.audio?.url.startsWith("https://media.test/")).toBe(true);
    expect(ready.audio && ready.audio.seconds).toBeGreaterThan(0);

    const lines = ready.lines ?? [];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.lineId.startsWith("ln_"))).toBe(true);
    expect(lines[0]?.startMs).toBe(0);

    const gap = FORMATS[episode.format].gapMs;
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i];
      if (l === undefined) continue;
      expect(typeof l.startMs).toBe("number");
      expect(typeof l.endMs).toBe("number");
      expect((l.endMs ?? 0) >= (l.startMs ?? 0)).toBe(true);
      if (i > 0) {
        const prev = lines[i - 1];
        expect(l.startMs).toBe((prev?.endMs ?? 0) + gap);
      }
    }
  });

  it("reports failed and rethrows when the source is missing", async () => {
    const { store } = makeStore();
    const services = makeServices(store);
    const episode = await planEpisode(services, {
      source: { kind: "topic", value: "No source stored" },
      format: "explainer",
      minutes: 6,
      principal: "user-1",
    });
    const part0 = episode.parts[0];
    if (part0 === undefined) throw new Error("expected a first part");

    const statuses: string[] = [];
    await expect(
      renderPart(services, episode, part0, "", (p) => {
        statuses.push(p.status);
      }),
    ).rejects.toThrow(/renderPart failed/);
    expect(statuses).toEqual(["scripting", "failed"]);
  });
});

describe("renderEpisode scheduler", () => {
  it("renders parts in index order and never lets a slow part finish after a later one", async () => {
    const { store, parts } = makeStore();
    // Make the middle part slow: if the scheduler were parallel, the fast last part would finish
    // first. Serial rendering means index order is preserved end to end.
    const services = makeServices(store, {
      scriptDelayMs: (h) => (h === "Slow middle" ? 60 : 0),
    });
    const episode = await planEpisode(services, {
      source: { kind: "topic", value: "The Fed decision" },
      format: "explainer",
      minutes: 6,
      principal: "user-1",
    });
    await store.createEpisode(episode, "Source text for the whole episode.");

    const events: { index: number; status: string }[] = [];
    const { done } = renderEpisode(services, episode, 0, (p) => {
      events.push({ index: p.index, status: p.status });
    });
    await done;

    const readyOrder = events.filter((e) => e.status === "ready").map((e) => e.index);
    expect(readyOrder).toEqual([0, 1, 2]);

    // The part index never decreases across the whole event stream, so no two parts overlapped.
    const indices = events.map((e) => e.index);
    for (let i = 1; i < indices.length; i += 1) {
      expect((indices[i] ?? -1) >= (indices[i - 1] ?? -1)).toBe(true);
    }
    expect(parts.size).toBe(3);
  });

  it("cancel stops before voicing the next part and leaves the current one ready", async () => {
    const { store } = makeStore();
    const services = makeServices(store);
    const episode = await planEpisode(services, {
      source: { kind: "topic", value: "The Fed decision" },
      format: "explainer",
      minutes: 6,
      principal: "user-1",
    });
    await store.createEpisode(episode, "Source text for the whole episode.");

    const events: { index: number; status: string }[] = [];
    const ctl = { cancel: (): void => {} };
    const onStatus = (p: Part): void => {
      events.push({ index: p.index, status: p.status });
      if (p.index === 0 && p.status === "voicing") ctl.cancel();
    };
    const handle = renderEpisode(services, episode, 0, onStatus);
    ctl.cancel = handle.cancel;
    await handle.done;

    // Part 0 was in flight when cancelled, so it finishes; parts 1 and 2 never start.
    expect(events.some((e) => e.index === 0 && e.status === "ready")).toBe(true);
    expect(events.every((e) => e.index === 0)).toBe(true);
  });
});

describe("expandPart", () => {
  it("returns a ready expansion part with timings and the parent linked", async () => {
    const { store } = makeStore();
    const services = makeServices(store);
    const episode = await planEpisode(services, {
      source: { kind: "topic", value: "The Fed decision" },
      format: "explainer",
      minutes: 6,
      principal: "user-1",
    });
    await store.createEpisode(episode, "Source text for the whole episode.");

    const parent = episode.parts[1];
    if (parent === undefined) throw new Error("expected a parent part");

    const statuses: string[] = [];
    const part = await expandPart(services, episode, parent.partId, "the dissent", "", (p) => {
      statuses.push(p.status);
    });

    expect(statuses).toEqual(["scripting", "voicing", "mixing", "ready"]);
    expect(part.origin).toBe("expansion");
    expect(part.expandsPartId).toBe(parent.partId);
    expect(part.status).toBe("ready");
    expect(part.heading).toBe("Deeper on the dissent");
    expect((part.lines ?? []).length).toBeGreaterThan(0);
    expect(part.lines?.[0]?.startMs).toBe(0);
    expect(part.audio?.mime).toBe("audio/mpeg");
  });
});

describe("fillers", () => {
  it("has six fillers per format with clean house-style text", () => {
    for (const f of FORMAT_IDS) {
      const lines = FILLER_LINES[f];
      expect(lines).toHaveLength(FILLERS_PER_FORMAT);
      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0);
        expect(line.includes("—")).toBe(false);
        expect(line.includes(", and")).toBe(false);
        expect(line.includes(", or")).toBe(false);
      }
    }
  });

  it("voices each filler once and picks them with wrap-around", async () => {
    const { store } = makeStore();
    const services = makeServices(store);
    const clips = await renderFillers(services);

    for (const f of FORMAT_IDS) {
      expect(clips.get(f)).toHaveLength(FILLERS_PER_FORMAT);
    }
    const first = pickFiller(clips, "explainer", 0);
    const wrapped = pickFiller(clips, "explainer", FILLERS_PER_FORMAT);
    const second = pickFiller(clips, "explainer", 1);
    expect(first).toBeDefined();
    expect(first).toBe(wrapped);
    expect(second).not.toBe(first);
    expect(pickFiller(clips, "explainer", -1)).toBeDefined();
    expect(pickFiller(new Map(), "explainer")).toBeUndefined();
  });
});
