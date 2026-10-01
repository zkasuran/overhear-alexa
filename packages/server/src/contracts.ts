// Frozen service contracts for the Overhear server. Every adapter, the render pipeline, the episode
// store and the tool handlers code against THESE interfaces, never a concrete class. Mock twins and
// AWS twins both satisfy them, so OVERHEAR_MODELS=mock|aws and OVERHEAR_STORE=local|aws are a factory
// choice, not a code fork. The MCP transport / task runtime wiring is separate (see transport.ts);
// those touch the SDK, these do not. Do not add provider types here.

import type {
  PromptMessages,
  LineTiming,
  Episode,
  Part,
  EpisodeManifest,
  FormatId,
  Speaker,
} from "@overhear/core";

/** Structured logger. Redacts `authorization` and token-shaped fields at the sink. No console in libs. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface ModelCallOpts {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Text model (Bedrock Converse or the deterministic mock). Returns raw text; the caller extracts JSON. */
export interface ModelAdapter {
  readonly id: string;
  generate(messages: PromptMessages, opts?: ModelCallOpts): Promise<string>;
}

export interface SynthResult {
  audio: Uint8Array;
  seconds: number;
  mime: "audio/mpeg";
}

/** Text to speech (Polly generative or the mock that replays a pre-rendered clip). */
export interface TtsAdapter {
  synthesize(
    text: string,
    voiceId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SynthResult>;
}

/** Audio publishing. Local mode writes a file and hands back a /media/{token} URL; AWS presigns S3. */
export interface StorageAdapter {
  putAudio(episodeId: string, partId: string, bytes: Uint8Array): Promise<string>; // returns opaque key
  urlFor(key: string): Promise<string>; // fresh presigned/served URL; S3 re-signs on each manifest read
}

export interface FetchedSource {
  text: string;
  contentType: string;
  finalUrl: string;
}

/** SSRF-guarded source fetcher with readable-text extraction. https only; private ranges refused. */
export interface FetchService {
  fetchUrl(url: string, opts?: { signal?: AbortSignal }): Promise<FetchedSource>;
}

export interface MixInput {
  lines: ReadonlyArray<{ audio: Uint8Array }>;
  gapMs: number;
  bedPath?: string;
  introStingPath?: string;
}

export interface MixResult {
  mp3: Uint8Array;
  seconds: number;
  lineTimings: LineTiming[]; // one per input line, in order
}

/** ffmpeg mixer: concat lines with gaps, lay the ducked bed, normalise to -16 LUFS, emit MP3. */
export interface Mixer {
  mix(input: MixInput): Promise<MixResult>;
}

/** Per-principal persistence of episodes, parts and source. Ownership is enforced here: a read for a
 * principal that does not own the episode returns null (never another principal's data). */
export interface EpisodeStore {
  createEpisode(ep: Episode, sourceText: string): Promise<void>;
  getEpisode(principal: string, episodeId: string): Promise<Episode | null>;
  getSource(principal: string, episodeId: string): Promise<string | null>;
  putPart(principal: string, episodeId: string, part: Part): Promise<void>;
  patchEpisode(
    principal: string,
    episodeId: string,
    patch: Partial<Pick<Episode, "title" | "dek" | "status" | "parts" | "updatedAt">>,
  ): Promise<void>;
  listByPrincipal(principal: string, limit: number): Promise<EpisodeManifest[]>;
  countEpisodesSince(principal: string, sinceIso: string): Promise<number>; // daily quota
  close(): Promise<void>;
}

/** Resolved, validated configuration. Built once at boot (config.ts); nothing else reads process.env. */
export interface Config {
  modelsMode: "mock" | "aws";
  storeMode: "local" | "aws";
  region: string;
  bedrock: { planModelId: string; scriptModelId: string };
  voices: Record<FormatId, Record<Speaker, string>>; // Polly generative voice id per format per speaker
  s3Bucket: string;
  tables: { episodes: string; tasks: string; events: string };
  bind: { host: string; port: number };
  bindPublic: boolean;
  originAllowlist: readonly string[]; // empty by default -> any browser Origin is 403
  tokenFile: string;
  mediaDir: string; // local store audio dir
  dataDir: string; // local store sqlite dir
  bedsDir: string; // format bed + sting assets
  presignTtlSeconds: number;
}

/** Dependency bundle handed to the pipeline and the tool handlers. */
export interface Services {
  config: Config;
  log: Logger;
  model: ModelAdapter;
  tts: TtsAdapter;
  storage: StorageAdapter;
  fetch: FetchService;
  mixer: Mixer;
  episodes: EpisodeStore;
  now: () => number; // injectable clock (Date.now in prod)
}
