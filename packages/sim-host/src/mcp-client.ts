// The MCP client to the episode server. It owns the bearer token (passed only in the transport headers,
// never to the browser) and exposes one typed method per tool the bridge needs. Task tools
// (render_episode, expand_part) are driven through the experimental task stream; sync and optional-task
// tools (plan_episode, find_moment, ask, get_episode) are plain calls. Structured results are read back
// defensively, since a tool result is validated by shape here before the bridge trusts it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TASK_POLL_INTERVAL_MS, TASK_TTL_MAX_MS } from "@overhear/core";
import type {
  AudioRef,
  Citation,
  FormatId,
  OutlinePart,
  PartStatus,
  SourceKind,
  Speaker,
} from "./protocol.js";
import type { Logger } from "./log.js";

const PROTOCOL_VERSION = "2025-11-25";

export type PlanInput = {
  source: { kind: SourceKind; value: string };
  minutes?: number;
  format?: FormatId;
  focus?: string;
};

export type PlanResult = {
  episodeId: string;
  title: string;
  dek: string;
  parts: OutlinePart[];
  totalEstSeconds: number;
  speakable: string;
};

export type ManifestPart = {
  index: number;
  partId: string;
  heading: string;
  summary: string;
  estSeconds: number;
  origin: "plan" | "expansion";
  status: PartStatus;
  audio?: AudioRef;
};

export type Manifest = {
  id: string;
  title: string;
  dek: string;
  format: FormatId;
  status: string;
  parts: ManifestPart[];
  targetSeconds: number;
};

export type MomentResult = {
  partId: string;
  index: number;
  offsetMs: number;
  heading: string;
  confidence: number;
  reason: string;
};

export type AskResult = {
  answer: string;
  speaker: Speaker;
  grounded: boolean;
  citations: Citation[];
  audio?: AudioRef;
};

export type EpisodeLine = {
  lineId: string;
  speaker: Speaker;
  text: string;
  startMs?: number;
  endMs?: number;
};

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}
function s(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const PART_STATUSES: readonly PartStatus[] = [
  "pending",
  "scripting",
  "voicing",
  "mixing",
  "ready",
  "failed",
];

function toAudio(v: unknown): AudioRef | undefined {
  const o = rec(v);
  if (o === undefined) return undefined;
  const url = s(o.url);
  const seconds = n(o.seconds);
  if (url === undefined || seconds === undefined) return undefined;
  return { url, seconds };
}

function toManifestPart(v: unknown): ManifestPart | undefined {
  const o = rec(v);
  if (o === undefined) return undefined;
  const partId = s(o.partId);
  const heading = s(o.heading) ?? "";
  const summary = s(o.summary) ?? "";
  const index = n(o.index) ?? 0;
  const estSeconds = n(o.estSeconds) ?? 0;
  const status = s(o.status);
  const origin = o.origin === "expansion" ? "expansion" : "plan";
  if (
    partId === undefined ||
    status === undefined ||
    !PART_STATUSES.includes(status as PartStatus)
  ) {
    return undefined;
  }
  const part: ManifestPart = {
    index,
    partId,
    heading,
    summary,
    estSeconds,
    origin,
    status: status as PartStatus,
  };
  const audio = toAudio(o.audio);
  if (audio) part.audio = audio;
  return part;
}

const FORMATS: readonly FormatId[] = ["explainer", "debate", "cozy", "hype"];
function toFormat(v: unknown): FormatId {
  return FORMATS.includes(v as FormatId) ? (v as FormatId) : "explainer";
}

function toManifest(v: unknown): Manifest | undefined {
  const o = rec(v);
  if (o === undefined) return undefined;
  const id = s(o.id);
  if (id === undefined) return undefined;
  const partsRaw = Array.isArray(o.parts) ? o.parts : [];
  const parts: ManifestPart[] = [];
  for (const p of partsRaw) {
    const mp = toManifestPart(p);
    if (mp) parts.push(mp);
  }
  parts.sort((a, b) => a.index - b.index);
  return {
    id,
    title: s(o.title) ?? "",
    dek: s(o.dek) ?? "",
    format: toFormat(o.format),
    status: s(o.status) ?? "planned",
    parts,
    targetSeconds: n(o.targetSeconds) ?? 0,
  };
}

function toOutlineParts(v: unknown): OutlinePart[] {
  const raw = Array.isArray(v) ? v : [];
  const out: OutlinePart[] = [];
  for (const p of raw) {
    const o = rec(p);
    if (o === undefined) continue;
    const partId = s(o.partId);
    if (partId === undefined) continue;
    out.push({
      index: n(o.index) ?? out.length,
      partId,
      heading: s(o.heading) ?? "",
      summary: s(o.summary) ?? "",
      estSeconds: n(o.estSeconds) ?? 0,
      status: "pending",
      origin: o.origin === "expansion" ? "expansion" : "plan",
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function toCitations(v: unknown): Citation[] {
  const raw = Array.isArray(v) ? v : [];
  const out: Citation[] = [];
  for (const c of raw) {
    const o = rec(c);
    if (o === undefined) continue;
    const partId = s(o.partId);
    const lineId = s(o.lineId);
    const quote = s(o.quote);
    if (partId === undefined || lineId === undefined || quote === undefined) continue;
    out.push({ partId, lineId, quote });
  }
  return out;
}

/** Thrown when a tool reports an execution error; the message is a sentence safe to read aloud. */
export class ToolError extends Error {}

/** The MCP client to the episode server. One instance per host process, connected once at startup. */
export class OverhearClient {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  readonly #log: Logger;

  constructor(serverUrl: string, token: string, log: Logger) {
    this.#log = log;
    this.#client = new Client(
      { name: "overhear-simulator", version: "1.0.0" },
      { capabilities: {} },
    );
    this.#transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
  }

  async connect(): Promise<void> {
    // The concrete transport differs from the Transport interface only in that its optional sessionId
    // is typed `string | undefined`; the assertion bridges that under exactOptionalPropertyTypes.
    await this.#client.connect(this.#transport as Transport);
    this.#log.info("mcp client connected", { protocol: PROTOCOL_VERSION });
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  /** The structuredContent of a plain tool call, or a ToolError when the tool reported one. */
  async #callStructured(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.#client.callTool({ name, arguments: args });
    if (result.isError === true) {
      const content = Array.isArray(result.content) ? result.content : [];
      const first = rec(content[0]);
      throw new ToolError(s(first?.text) ?? "That request could not be completed.");
    }
    const structured = rec(result.structuredContent);
    if (structured === undefined) throw new ToolError("The server returned no result.");
    return structured;
  }

  /** The structuredContent of a task tool, driven to completion through the task stream. */
  async #callTaskStructured(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const stream = this.#client.experimental.tasks.callToolStream(
      { name, arguments: args },
      undefined,
      { task: { ttl: TASK_TTL_MAX_MS, pollInterval: TASK_POLL_INTERVAL_MS } },
    );
    for await (const message of stream) {
      if (message.type === "error") throw new ToolError(message.error.message);
      if (message.type === "result") {
        const result = message.result;
        if (result.isError === true) {
          const content = Array.isArray(result.content) ? result.content : [];
          const first = rec(content[0]);
          throw new ToolError(s(first?.text) ?? "That request could not be completed.");
        }
        const structured = rec(result.structuredContent);
        if (structured === undefined) throw new ToolError("The server returned no result.");
        return structured;
      }
    }
    throw new ToolError("The task ended without a result.");
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    const args: Record<string, unknown> = { source: input.source };
    if (input.minutes !== undefined) args.minutes = input.minutes;
    if (input.format !== undefined) args.format = input.format;
    if (input.focus !== undefined) args.focus = input.focus;
    const sc = await this.#callStructured("plan_episode", args);
    const episodeId = s(sc.episodeId);
    if (episodeId === undefined) throw new ToolError("Planning returned no episode.");
    return {
      episodeId,
      title: s(sc.title) ?? "",
      dek: s(sc.dek) ?? "",
      parts: toOutlineParts(sc.parts),
      totalEstSeconds: n(sc.totalEstSeconds) ?? 0,
      speakable: s(sc.speakable) ?? "",
    };
  }

  /** Start rendering. The returned promise resolves when the whole task completes. Parts become
   * playable earlier and are observed by polling the manifest; this is the "all done" signal. */
  async render(episodeId: string, fromPart = 0): Promise<void> {
    await this.#callTaskStructured("render_episode", { episodeId, fromPart });
  }

  async subscribeManifest(uri: string): Promise<void> {
    // The server tracks the subscription; in local mode the manifest is then polled for part status,
    // since the HTTP transport opens no standalone notification stream. Best-effort, never fatal.
    try {
      await this.#client.subscribeResource({ uri });
    } catch (err) {
      this.#log.warn("manifest subscribe failed", { uri, error: String(err) });
    }
  }

  async readManifest(episodeId: string): Promise<Manifest | undefined> {
    const uri = `overhear://episodes/${episodeId}/manifest`;
    const result = await this.#client.readResource({ uri });
    const contents = Array.isArray(result.contents) ? result.contents : [];
    const first = rec(contents[0]);
    const text = s(first?.text);
    if (text === undefined) return undefined;
    try {
      return toManifest(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  async findMoment(
    episodeId: string,
    query: string,
    from?: { partId: string; offsetMs: number },
  ): Promise<MomentResult> {
    const args: Record<string, unknown> = { episodeId, query };
    if (from !== undefined) args.from = from;
    const sc = await this.#callStructured("find_moment", args);
    const partId = s(sc.partId);
    if (partId === undefined) throw new ToolError("I could not work out which part you meant.");
    return {
      partId,
      index: n(sc.index) ?? 0,
      offsetMs: n(sc.offsetMs) ?? 0,
      heading: s(sc.heading) ?? "",
      confidence: n(sc.confidence) ?? 0,
      reason: s(sc.reason) ?? "",
    };
  }

  async expandPart(
    episodeId: string,
    partId: string,
    angle?: string,
  ): Promise<ManifestPart | undefined> {
    const args: Record<string, unknown> = { episodeId, partId };
    if (angle !== undefined) args.angle = angle;
    const sc = await this.#callTaskStructured("expand_part", args);
    return toManifestPart(sc.inserted);
  }

  async ask(
    episodeId: string,
    question: string,
    at?: { partId: string; offsetMs: number },
  ): Promise<AskResult> {
    const args: Record<string, unknown> = { episodeId, question };
    if (at !== undefined) args.at = at;
    const sc = await this.#callStructured("ask", args);
    const result: AskResult = {
      answer: s(sc.answer) ?? "",
      speaker: sc.speaker === "host" ? "host" : "expert",
      grounded: sc.grounded === true,
      citations: toCitations(sc.citations),
    };
    const audio = toAudio(sc.audio);
    if (audio) result.audio = audio;
    return result;
  }

  /** The full episode with per-line detail, used to drive synced captions. Lines carry mix timings. */
  async getEpisodeLines(episodeId: string): Promise<Map<string, EpisodeLine[]>> {
    const sc = await this.#callStructured("get_episode", { episodeId, include: ["lines"] });
    const parts = Array.isArray(sc.parts) ? sc.parts : [];
    const byPart = new Map<string, EpisodeLine[]>();
    for (const p of parts) {
      const o = rec(p);
      if (o === undefined) continue;
      const partId = s(o.partId);
      if (partId === undefined) continue;
      const linesRaw = Array.isArray(o.lines) ? o.lines : [];
      const lines: EpisodeLine[] = [];
      for (const l of linesRaw) {
        const lo = rec(l);
        if (lo === undefined) continue;
        const lineId = s(lo.lineId);
        const text = s(lo.text);
        if (lineId === undefined || text === undefined) continue;
        const line: EpisodeLine = {
          lineId,
          speaker: lo.speaker === "host" ? "host" : "expert",
          text,
        };
        const startMs = n(lo.startMs);
        const endMs = n(lo.endMs);
        if (startMs !== undefined) line.startMs = startMs;
        if (endMs !== undefined) line.endMs = endMs;
        lines.push(line);
      }
      byPart.set(partId, lines);
    }
    return byPart;
  }
}
