// The gapless Web Audio player. One AudioContext drives everything: episode parts play back to back on
// an episode gain node, the producer's talk-over ducks that gain, an answer plays on its own node, and
// a quiet pad covers any stall so a gap between parts is never dead silence. Parts arrive out of order
// and late (expansions, render-ahead), so scheduling is driven by what is decoded, not by arrival.

import {
  DUCK_GAIN,
  EPISODE_GAIN,
  FETCH_TIMEOUT_MS,
  FILLER_GAIN,
  GAIN_RAMP_SECONDS,
  MAX_AUDIO_BYTES,
} from "./config.js";
import type { CaptionLine, PartOrigin } from "./protocol.js";

export type NowPlaying = {
  partId: string;
  index: number;
  withinMs: number;
  elapsedSeconds: number;
  totalSeconds: number;
  line: CaptionLine | undefined;
};

export type PlayerCallbacks = {
  onTick: (now: NowPlaying | null) => void;
  onPlayingChange: (playing: boolean) => void;
  onError: (message: string) => void;
};

type Part = {
  partId: string;
  index: number;
  origin: PartOrigin;
  seconds: number;
  lines: CaptionLine[];
  buffer: AudioBuffer | undefined;
};

type Scheduled = {
  index: number;
  source: AudioBufferSourceNode;
  startTime: number;
  endTime: number;
  startOffsetSec: number;
};

function activeLine(lines: readonly CaptionLine[], withinMs: number): CaptionLine | undefined {
  let found: CaptionLine | undefined;
  for (const line of lines) {
    if (line.startMs === undefined) continue;
    if (line.startMs <= withinMs) found = line;
    else break;
  }
  return found ?? lines[0];
}

export class Player {
  readonly #ctx: AudioContext;
  readonly #master: GainNode;
  readonly #episode: GainNode;
  readonly #answer: GainNode;
  readonly #filler: GainNode;
  readonly #cb: PlayerCallbacks;

  #parts: Part[] = [];
  #scheduled: Scheduled[] = [];
  #scheduleIndex = 0;
  #scheduleOffsetSec = 0;
  #tailTime = 0;
  #wantPlay = false;
  #expectedCount = 0;
  #ducked = false;
  #fillerOsc: OscillatorNode | undefined;
  #lastPlaying = false;
  #lastPosition: { partId: string; offsetMs: number } | null = null;
  #tick: ReturnType<typeof setInterval> | undefined;

  constructor(cb: PlayerCallbacks) {
    this.#cb = cb;
    this.#ctx = new AudioContext();
    this.#master = this.#ctx.createGain();
    this.#episode = this.#ctx.createGain();
    this.#answer = this.#ctx.createGain();
    this.#filler = this.#ctx.createGain();
    this.#master.gain.value = 1;
    this.#episode.gain.value = EPISODE_GAIN;
    this.#answer.gain.value = 1;
    this.#filler.gain.value = 0;
    this.#episode.connect(this.#master);
    this.#answer.connect(this.#master);
    this.#filler.connect(this.#master);
    this.#master.connect(this.#ctx.destination);
    this.#tick = setInterval(() => this.#onTick(), 120);
  }

  /** Clear everything for a new episode. */
  reset(): void {
    this.#stopAll();
    this.#parts = [];
    this.#scheduleIndex = 0;
    this.#scheduleOffsetSec = 0;
    this.#tailTime = 0;
    this.#wantPlay = false;
    this.#expectedCount = 0;
  }

  setExpectedCount(count: number): void {
    this.#expectedCount = count;
  }

  /** Fetch and decode a part's audio, then schedule it if playback is running. */
  async addPart(input: {
    partId: string;
    index: number;
    origin: PartOrigin;
    url: string;
    seconds: number;
    lines: CaptionLine[];
  }): Promise<void> {
    let buffer: AudioBuffer;
    try {
      buffer = await this.#load(input.url);
    } catch (err) {
      this.#cb.onError(`Could not load audio for "${input.index + 1}". ${String(err)}`);
      return;
    }
    const part: Part = {
      partId: input.partId,
      index: input.index,
      origin: input.origin,
      seconds: input.seconds,
      lines: input.lines,
      buffer,
    };
    const existing = this.#parts.findIndex((p) => p.partId === part.partId);
    if (existing >= 0) this.#parts[existing] = part;
    else this.#parts.push(part);
    this.#parts.sort((a, b) => a.index - b.index);
    if (this.#expectedCount < this.#parts.length) this.#expectedCount = this.#parts.length;
    if (this.#wantPlay) this.#pump();
  }

  /** Start playback from the first part. A user gesture, so the AudioContext may be resumed here. */
  async play(): Promise<void> {
    if (this.#ctx.state === "suspended") await this.#ctx.resume().catch(() => undefined);
    if (!this.#wantPlay && this.#scheduled.length === 0) {
      this.#scheduleIndex = 0;
      this.#scheduleOffsetSec = 0;
      this.#tailTime = this.#ctx.currentTime;
    }
    this.#wantPlay = true;
    this.#pump();
  }

  async pause(): Promise<void> {
    if (this.#ctx.state === "running") await this.#ctx.suspend().catch(() => undefined);
  }

  async resume(): Promise<void> {
    if (this.#ctx.state === "suspended") await this.#ctx.resume().catch(() => undefined);
  }

  /** Jump to a part at an offset. Used for skip and back once the host resolves the moment. */
  seekTo(index: number, offsetSec: number): void {
    this.#stopScheduled();
    this.#scheduleIndex = index;
    this.#scheduleOffsetSec = Math.max(0, offsetSec);
    this.#tailTime = this.#ctx.currentTime;
    this.#wantPlay = true;
    void this.resume();
    this.#pump();
  }

  setDucked(active: boolean): void {
    this.#ducked = active;
    const target = active ? DUCK_GAIN : EPISODE_GAIN;
    this.#episode.gain.setTargetAtTime(target, this.#ctx.currentTime, GAIN_RAMP_SECONDS);
  }

  /** Play an answer over the episode: duck the episode, play on the answer node, restore when it ends. */
  async playAnswer(url: string): Promise<void> {
    let buffer: AudioBuffer;
    try {
      buffer = await this.#load(url);
    } catch (err) {
      this.#cb.onError(`Could not load the answer audio. ${String(err)}`);
      return;
    }
    if (this.#ctx.state === "suspended") await this.#ctx.resume().catch(() => undefined);
    this.#episode.gain.setTargetAtTime(DUCK_GAIN, this.#ctx.currentTime, GAIN_RAMP_SECONDS);
    const src = this.#ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.#answer);
    src.addEventListener("ended", () => {
      if (!this.#ducked) {
        this.#episode.gain.setTargetAtTime(EPISODE_GAIN, this.#ctx.currentTime, GAIN_RAMP_SECONDS);
      }
    });
    src.start();
  }

  getPosition(): { partId: string; offsetMs: number } | null {
    return this.#lastPosition;
  }

  dispose(): void {
    if (this.#tick !== undefined) clearInterval(this.#tick);
    this.#stopAll();
    void this.#ctx.close().catch(() => undefined);
  }

  #part(index: number): Part | undefined {
    return this.#parts.find((p) => p.index === index);
  }

  /** Schedule every decoded part that follows the last scheduled one, back to back. */
  #pump(): void {
    if (!this.#wantPlay) return;
    for (;;) {
      const part = this.#part(this.#scheduleIndex);
      if (part === undefined || part.buffer === undefined) break;
      const startAt = Math.max(this.#tailTime, this.#ctx.currentTime);
      const offset = this.#scheduleOffsetSec;
      this.#scheduleOffsetSec = 0;
      const source = this.#ctx.createBufferSource();
      source.buffer = part.buffer;
      source.connect(this.#episode);
      source.start(startAt, offset);
      const endTime = startAt + Math.max(0, part.buffer.duration - offset);
      this.#scheduled.push({
        index: part.index,
        source,
        startTime: startAt,
        endTime,
        startOffsetSec: offset,
      });
      this.#tailTime = endTime;
      this.#scheduleIndex = part.index + 1;
      this.#stopFiller();
    }
  }

  #onTick(): void {
    const now = this.#ctx.currentTime;
    this.#scheduled = this.#scheduled.filter((s) => s.endTime > now - 1);
    const current = this.#scheduled.find((s) => s.startTime <= now && now < s.endTime);
    const total = this.#parts.reduce((sum, p) => sum + p.seconds, 0);

    if (current !== undefined) {
      const part = this.#part(current.index);
      const withinSec = current.startOffsetSec + (now - current.startTime);
      const withinMs = withinSec * 1000;
      let before = 0;
      for (const p of this.#parts) if (p.index < current.index) before += p.seconds;
      const line = part !== undefined ? activeLine(part.lines, withinMs) : undefined;
      this.#lastPosition =
        part !== undefined ? { partId: part.partId, offsetMs: Math.round(withinMs) } : null;
      this.#cb.onTick({
        partId: part?.partId ?? "",
        index: current.index,
        withinMs: Math.round(withinMs),
        elapsedSeconds: Math.round(before + withinSec),
        totalSeconds: Math.round(total),
        line,
      });
    } else {
      this.#cb.onTick(null);
    }

    // Stall: playing, nothing current, but more parts are expected and not yet decoded.
    const stalled =
      this.#wantPlay &&
      current === undefined &&
      this.#ctx.state === "running" &&
      this.#scheduleIndex < this.#expectedCount &&
      this.#part(this.#scheduleIndex)?.buffer === undefined;
    if (stalled) this.#startFiller();
    else if (current !== undefined) this.#stopFiller();

    const playing = current !== undefined && this.#ctx.state === "running";
    if (playing !== this.#lastPlaying) {
      this.#lastPlaying = playing;
      this.#cb.onPlayingChange(playing);
    }
  }

  async #load(url: string): Promise<AudioBuffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("audio too large");
      return await this.#ctx.decodeAudioData(bytes);
    } finally {
      clearTimeout(timer);
    }
  }

  #stopScheduled(): void {
    for (const s of this.#scheduled) {
      try {
        s.source.stop();
      } catch {
        // Already stopped or never started; nothing to do.
      }
    }
    this.#scheduled = [];
  }

  #stopAll(): void {
    this.#stopScheduled();
    this.#stopFiller();
  }

  #startFiller(): void {
    if (this.#fillerOsc !== undefined) return;
    const osc = this.#ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 110;
    osc.connect(this.#filler);
    osc.start();
    this.#fillerOsc = osc;
    this.#filler.gain.setTargetAtTime(FILLER_GAIN, this.#ctx.currentTime, GAIN_RAMP_SECONDS);
  }

  #stopFiller(): void {
    if (this.#fillerOsc === undefined) return;
    const osc = this.#fillerOsc;
    this.#fillerOsc = undefined;
    this.#filler.gain.setTargetAtTime(0, this.#ctx.currentTime, 0.1);
    try {
      osc.stop(this.#ctx.currentTime + 0.3);
    } catch {
      // Oscillator may already be stopping.
    }
  }
}
