// The bridge: one Session per browser connection. It turns WebSocket commands into MCP calls and tool
// results into events the device UI can render. The split that matters is the producer-vs-talent one.
// Meta intents (pause, resume, time-left) resolve here with no model call; skip and back resolve through
// find_moment's deterministic path; only content intents (go-deeper, ask) call a content tool. A free
// utterance is classified first, so a demo without cloud speech still shows that routing.
//
// Rendering is observed by polling the manifest: parts become playable before the render task finishes,
// and each poll hands any newly playable part to the browser once, with its lines for synced captions.

import { MAX_EXPANSIONS } from "@overhear/core";
import { classifyUtterance } from "./intent.js";
import { parseCommand } from "./commands.js";
import { diffManifest } from "./manifest-diff.js";
import { computeTimeLeft } from "./timing.js";
import { proxyAudioUrl } from "./media-proxy.js";
import { ToolError } from "./mcp-client.js";
import type { EpisodeLine, OverhearClient } from "./mcp-client.js";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import type {
  CaptionLine,
  Command,
  Event,
  FormatId,
  OutlinePart,
  PartOrigin,
  Position,
  RingState,
} from "./protocol.js";

const POLL_INTERVAL_MS = 500;
const POLL_MAX_MS = 180_000;
const POLL_GRACE_MS = 2_000;

export type RunMode = { mode: "mock" | "aws"; store: "local" | "aws" };

function producerDurationMs(text: string): number {
  return Math.min(6_000, Math.max(1_200, text.length * 55));
}

function toCaptionLines(lines: readonly EpisodeLine[]): CaptionLine[] {
  return lines.map((l) => {
    const c: CaptionLine = { lineId: l.lineId, speaker: l.speaker, text: l.text };
    if (l.startMs !== undefined) c.startMs = l.startMs;
    if (l.endMs !== undefined) c.endMs = l.endMs;
    return c;
  });
}

/** One browser connection's state and command handling. */
export class Session {
  readonly #send: (event: Event) => void;
  readonly #client: OverhearClient;
  readonly #config: Config;
  readonly #log: Logger;
  readonly #mode: RunMode;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  #episodeId: string | undefined;
  #title = "";
  #dek = "";
  #format: FormatId = "explainer";
  #speakable = "";
  #outline: OutlinePart[] = [];
  #partSeconds = new Map<string, number>();
  #lastStatus = new Map<string, string>();
  #readyEmitted = new Set<string>();
  #linesByPart = new Map<string, EpisodeLine[]>();
  #rendering = false;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #pollDeadline = 0;
  #renderDoneAt = 0;
  #expansions = 0;
  #disposed = false;

  constructor(
    send: (event: Event) => void,
    client: OverhearClient,
    config: Config,
    log: Logger,
    mode: RunMode,
  ) {
    this.#send = send;
    this.#client = client;
    this.#config = config;
    this.#log = log;
    this.#mode = mode;
  }

  /** Greet the browser with the run mode and the producer it will get. */
  start(): void {
    const producer = "push-to-talk" as const;
    const label =
      this.#mode.mode === "mock"
        ? "Mock models, recorded samples. Push-to-talk producer (the Sonic voice needs AWS)."
        : "Live models. Push-to-talk producer (the Sonic voice needs AWS).";
    this.#send({
      type: "status",
      mode: this.#mode.mode,
      store: this.#mode.store,
      producer,
      serverOk: true,
      label,
    });
    this.#ring("idle");
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  /** Entry point for a raw WebSocket frame. Never throws: a bad frame becomes a spoken notice. */
  async handle(raw: unknown): Promise<void> {
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      this.#log.warn("rejected command", { reason: parsed.reason });
      return;
    }
    try {
      await this.#dispatch(parsed.command);
    } catch (err) {
      if (err instanceof ToolError) {
        this.#notice("error", err.message);
      } else {
        this.#log.error("command failed", { error: String(err) });
        this.#notice("error", "Something went wrong handling that. Try again.");
      }
      this.#ring("idle");
    }
  }

  async #dispatch(command: Command): Promise<void> {
    switch (command.type) {
      case "plan":
        return this.#plan(command);
      case "play":
        return this.#play();
      case "pause":
        return this.#pauseResume(true);
      case "resume":
        return this.#pauseResume(false);
      case "skip":
        return this.#move("skip", command.from);
      case "back":
        return this.#move("back", command.from);
      case "go-deeper":
        return this.#goDeeper(command.from, command.angle);
      case "ask":
        return this.#ask(command.question, command.at);
      case "time-left":
        return this.#timeLeft(command.positionSeconds);
      case "utterance":
        return this.#dispatch(classifyUtterance(command.text, command.from));
    }
  }

  // Helpers for the common event shapes.

  #ring(state: RingState): void {
    this.#send({ type: "ring", state });
  }

  #notice(level: "info" | "error", text: string): void {
    this.#send({ type: "notice", level, text });
  }

  /** The producer speaks over the episode: caption, ring, and a ducking window that releases on its own. */
  #speakProducer(text: string): void {
    this.#send({ type: "caption", speaker: "producer", text });
    this.#send({ type: "ducking", active: true });
    this.#ring("speaking");
    const t = setTimeout(() => {
      this.#timers.delete(t);
      if (this.#disposed) return;
      this.#send({ type: "ducking", active: false });
      this.#ring("idle");
    }, producerDurationMs(text));
    this.#timers.add(t);
  }

  #totalSeconds(): number {
    let total = 0;
    for (const p of this.#outline) total += this.#partSeconds.get(p.partId) ?? p.estSeconds;
    return total;
  }

  // __METHODS__

  async #plan(command: Extract<Command, { type: "plan" }>): Promise<void> {
    this.#stopPoll();
    this.#rendering = false;
    this.#ring("thinking");
    const input: Parameters<OverhearClient["plan"]>[0] = { source: command.source };
    if (command.minutes !== undefined) input.minutes = command.minutes;
    if (command.format !== undefined) input.format = command.format;
    if (command.focus !== undefined) input.focus = command.focus;

    const plan = await this.#client.plan(input);
    this.#episodeId = plan.episodeId;
    this.#title = plan.title;
    this.#dek = plan.dek;
    this.#format = command.format ?? "explainer";
    this.#speakable = plan.speakable;
    this.#outline = plan.parts;
    this.#partSeconds = new Map(plan.parts.map((p) => [p.partId, p.estSeconds]));
    this.#lastStatus = new Map(plan.parts.map((p) => [p.partId, p.status]));
    this.#readyEmitted = new Set();
    this.#linesByPart = new Map();
    this.#expansions = 0;

    this.#sendOutline();
    this.#speakProducer(`${plan.speakable} Say play to start the audio.`);
  }

  #sendOutline(): void {
    if (this.#episodeId === undefined) return;
    this.#send({
      type: "outline",
      episodeId: this.#episodeId,
      title: this.#title,
      dek: this.#dek,
      format: this.#format,
      parts: this.#outline.map((p) => ({ ...p })),
      totalEstSeconds: this.#totalSeconds(),
      speakable: this.#speakable,
    });
  }

  async #play(): Promise<void> {
    if (this.#episodeId === undefined) {
      this.#notice("error", "Plan an episode first, then say play.");
      return;
    }
    if (this.#rendering) {
      this.#notice("info", "Already building this episode.");
      return;
    }
    const episodeId = this.#episodeId;
    this.#ring("thinking");
    await this.#client.subscribeManifest(`overhear://episodes/${episodeId}/manifest`);
    this.#speakProducer("Starting now. The first part plays as soon as it is ready.");
    this.#rendering = true;
    this.#renderDoneAt = 0;
    this.#client
      .render(episodeId)
      .then(() => {
        this.#renderDoneAt = Date.now();
        if (this.#disposed) return;
        this.#send({ type: "render-done", episodeId, totalSeconds: this.#totalSeconds() });
      })
      .catch((err: unknown) => {
        this.#renderDoneAt = Date.now();
        if (this.#disposed) return;
        this.#notice("error", err instanceof ToolError ? err.message : "Rendering failed.");
      });
    this.#startPoll();
  }

  #startPoll(): void {
    this.#pollDeadline = Date.now() + POLL_MAX_MS;
    const tick = (): void => {
      if (this.#disposed) return;
      void this.#pollOnce().finally(() => {
        if (this.#disposed) return;
        const done = this.#renderDoneAt > 0 && Date.now() > this.#renderDoneAt + POLL_GRACE_MS;
        if (done || Date.now() > this.#pollDeadline) {
          this.#rendering = false;
          return;
        }
        this.#pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      });
    };
    tick();
  }

  #stopPoll(): void {
    if (this.#pollTimer !== undefined) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }

  async #pollOnce(): Promise<void> {
    if (this.#episodeId === undefined) return;
    const manifest = await this.#client.readManifest(this.#episodeId);
    if (manifest === undefined) return;
    await this.#applyManifest(manifest);
  }

  async #applyManifest(
    manifest: Awaited<ReturnType<OverhearClient["readManifest"]>>,
  ): Promise<void> {
    if (manifest === undefined || this.#episodeId === undefined) return;
    const diff = diffManifest(this.#lastStatus, this.#readyEmitted, manifest.parts);

    // Keep the outline mirror in sync with the manifest (expansions appear here as new parts).
    this.#outline = manifest.parts.map((p) => ({
      index: p.index,
      partId: p.partId,
      heading: p.heading,
      summary: p.summary,
      estSeconds: p.estSeconds,
      status: p.status,
      origin: p.origin,
    }));
    for (const p of manifest.parts) {
      if (p.audio !== undefined) this.#partSeconds.set(p.partId, p.audio.seconds);
    }

    // Load line-level timings once a part is ready but its lines are not cached yet, for captions.
    const needLines = diff.newlyReady.some((p) => !this.#linesByPart.has(p.partId));
    if (needLines) {
      try {
        this.#linesByPart = await this.#client.getEpisodeLines(this.#episodeId);
      } catch (err) {
        this.#log.warn("line fetch failed", { error: String(err) });
      }
    }

    if (diff.newParts.length > 0) {
      this.#sendOutline();
    } else {
      for (const p of diff.statusChanged) {
        this.#send({
          type: "part-status",
          partId: p.partId,
          index: p.index,
          status: p.status,
          heading: p.heading,
        });
      }
    }

    for (const p of diff.newlyReady) {
      if (p.audio === undefined) continue;
      const lines = this.#linesByPart.get(p.partId);
      const event: Extract<Event, { type: "part-ready" }> = {
        type: "part-ready",
        partId: p.partId,
        index: p.index,
        heading: p.heading,
        origin: p.origin as PartOrigin,
        audio: {
          url: proxyAudioUrl(p.audio.url, this.#publicBase()),
          seconds: p.audio.seconds,
        },
      };
      if (lines !== undefined && lines.length > 0) event.lines = toCaptionLines(lines);
      this.#send(event);
      this.#readyEmitted.add(p.partId);
    }

    this.#lastStatus = new Map(manifest.parts.map((p) => [p.partId, p.status]));
  }

  #publicBase(): string {
    return `http://${this.#config.host}:${this.#config.port}`;
  }

  async #move(intent: "skip" | "back", from?: Position): Promise<void> {
    if (this.#episodeId === undefined) {
      this.#notice("error", "There is nothing playing yet.");
      return;
    }
    this.#ring("thinking");
    const query = intent === "skip" ? "next" : "back 30 seconds";
    const moment = await this.#client.findMoment(this.#episodeId, query, from);
    this.#send({
      type: "moment",
      intent,
      partId: moment.partId,
      index: moment.index,
      offsetMs: moment.offsetMs,
      heading: moment.heading,
      confidence: moment.confidence,
      reason: moment.reason,
    });
    this.#speakProducer(
      moment.reason.length > 0 ? moment.reason : `Taking you to ${moment.heading}.`,
    );
  }

  async #goDeeper(from?: Position, angle?: string): Promise<void> {
    if (this.#episodeId === undefined) {
      this.#notice("error", "Plan an episode first.");
      return;
    }
    if (this.#expansions >= MAX_EXPANSIONS) {
      this.#notice("info", "That is as many follow-ups as I can add to one episode.");
      return;
    }
    const partId = from?.partId ?? this.#outline[this.#outline.length - 1]?.partId;
    if (partId === undefined) {
      this.#notice("error", "There is no part to go deeper on yet.");
      return;
    }
    this.#ring("thinking");
    this.#speakProducer("Give me a moment, I will add more on that.");
    await this.#client.expandPart(this.#episodeId, partId, angle);
    this.#expansions += 1;
    await this.#pollOnce();
  }

  async #ask(question: string, at?: Position): Promise<void> {
    if (this.#episodeId === undefined) {
      this.#notice("error", "Plan an episode first.");
      return;
    }
    this.#ring("thinking");
    this.#speakProducer("Let me check that against the episode.");
    const result = await this.#client.ask(this.#episodeId, question, at);
    const event: Extract<Event, { type: "answer" }> = {
      type: "answer",
      question,
      answer: result.answer,
      speaker: result.speaker,
      grounded: result.grounded,
      citations: result.citations,
    };
    if (result.audio !== undefined) {
      event.audio = {
        url: proxyAudioUrl(result.audio.url, this.#publicBase()),
        seconds: result.audio.seconds,
      };
    }
    this.#send(event);
  }

  #timeLeft(positionSeconds: number): void {
    const total = this.#totalSeconds();
    const tl = computeTimeLeft(positionSeconds, total);
    this.#send({
      type: "time-left",
      elapsedSeconds: tl.elapsedSeconds,
      remainingSeconds: tl.remainingSeconds,
      totalSeconds: tl.totalSeconds,
      speakable: tl.speakable,
    });
    this.#speakProducer(tl.speakable);
  }

  #pauseResume(pause: boolean): void {
    // A pure meta intent: no model, no MCP call. The browser has already paused or resumed its own
    // player; the producer only acknowledges it.
    this.#speakProducer(pause ? "Paused." : "Back on.");
  }
}
