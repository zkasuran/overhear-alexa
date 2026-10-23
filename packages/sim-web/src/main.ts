// The controller. It wires the socket, the player and the view together: events from the host update
// the device and feed the player, and controls turn into commands plus the local player actions for the
// meta intents. The ring light is computed from three local facts (talking, playing, thinking) so it
// stays truthful even though several of them change independently.

import { buildControls } from "./controls.js";
import type { CommandSink, PlanInput } from "./controls.js";
import { DeviceView } from "./device.js";
import { el } from "./dom.js";
import { Player } from "./player.js";
import type { NowPlaying } from "./player.js";
import { SimSocket } from "./wsclient.js";
import type { LinkState } from "./wsclient.js";
import { buildShell } from "./shell.js";
import { initThemeToggle } from "./theme.js";
import type { Event, RingState } from "./protocol.js";

export class App {
  readonly #device: DeviceView;
  readonly #player: Player;
  readonly #socket: SimSocket;
  readonly #shell: ReturnType<typeof buildShell>;

  #hostRing: RingState = "idle";
  #playing = false;
  #ptt = false;
  #elapsed = 0;
  #lastLineId: string | undefined;

  constructor(root: HTMLElement) {
    this.#shell = buildShell(root);
    initThemeToggle(this.#shell.themeButton);
    this.#device = new DeviceView(this.#shell.deviceRoot);
    this.#player = new Player({
      onTick: (now) => this.#onTick(now),
      onPlayingChange: (p) => {
        this.#playing = p;
        this.#updateRing();
      },
      onError: (message) => this.#notice("error", message),
    });
    this.#socket = new SimSocket({
      onEvent: (ev) => this.#onEvent(ev),
      onState: (s) => this.#onLink(s),
    });
    buildControls(this.#shell.controlsRoot, this.#sink());
    this.#socket.connect();
  }

  #sink(): CommandSink {
    const send = this.#socket.send.bind(this.#socket);
    const pos = (): { partId: string; offsetMs: number } | undefined =>
      this.#player.getPosition() ?? undefined;
    return {
      plan: (input: PlanInput) =>
        send({
          type: "plan",
          source: { kind: input.kind, value: input.value },
          minutes: input.minutes,
          format: input.format,
        }),
      play: () => {
        void this.#player.play();
        send({ type: "play" });
      },
      pause: () => {
        void this.#player.pause();
        send({ type: "pause" });
      },
      resume: () => {
        void this.#player.resume();
        send({ type: "resume" });
      },
      skip: () => {
        const p = pos();
        send(p ? { type: "skip", from: p } : { type: "skip" });
      },
      back: () => {
        const p = pos();
        send(p ? { type: "back", from: p } : { type: "back" });
      },
      goDeeper: () => {
        const p = pos();
        send(p ? { type: "go-deeper", from: p } : { type: "go-deeper" });
      },
      timeLeft: () => send({ type: "time-left", positionSeconds: this.#elapsed }),
      ask: (question: string) => {
        const p = pos();
        send(p ? { type: "ask", question, at: p } : { type: "ask", question });
      },
      utterance: (text: string) => {
        const p = pos();
        send(p ? { type: "utterance", text, from: p } : { type: "utterance", text });
      },
      pttActive: (active: boolean) => {
        this.#ptt = active;
        this.#updateRing();
      },
    };
  }

  #onEvent(ev: Event): void {
    try {
      this.#handle(ev);
    } catch (err) {
      this.#notice("error", `Could not handle a ${ev.type} update. ${String(err)}`);
    }
  }

  #handle(ev: Event): void {
    switch (ev.type) {
      case "status":
        this.#device.setMode(
          ev.mode === "mock" ? "mock, recorded samples" : "live, Amazon Polly voices",
        );
        this.#notice("info", ev.label);
        break;
      case "ring":
        this.#hostRing = ev.state;
        this.#updateRing();
        break;
      case "outline":
        this.#player.reset();
        this.#player.setExpectedCount(ev.parts.length);
        this.#device.setOutline(ev);
        this.#elapsed = 0;
        this.#lastLineId = undefined;
        break;
      case "part-status":
        this.#device.setPartStatus(ev.partId, ev.status);
        break;
      case "part-ready":
        this.#device.setPartStatus(ev.partId, "ready");
        void this.#player.addPart({
          partId: ev.partId,
          index: ev.index,
          origin: ev.origin,
          url: ev.audio.url,
          seconds: ev.audio.seconds,
          lines: ev.lines ?? [],
        });
        break;
      case "caption":
        this.#device.setCaption(ev.speaker, ev.text);
        break;
      case "ducking":
        this.#player.setDucked(ev.active);
        break;
      case "answer":
        this.#device.setCaption(ev.speaker, ev.answer);
        if (ev.audio !== undefined) void this.#player.playAnswer(ev.audio.url);
        if (!ev.grounded) this.#notice("info", "That was not covered by the episode.");
        break;
      case "moment":
        this.#player.seekTo(ev.index, ev.offsetMs / 1000);
        break;
      case "time-left":
        this.#notice("info", ev.speakable);
        break;
      case "notice":
        this.#notice(ev.level, ev.text);
        break;
      case "render-done":
        this.#notice("info", "The episode is fully rendered.");
        break;
    }
  }

  #onTick(now: NowPlaying | null): void {
    if (now === null) return;
    this.#elapsed = now.elapsedSeconds;
    this.#device.markPlaying(now.partId);
    this.#device.setProgress(now.elapsedSeconds, now.totalSeconds);
    if (now.line !== undefined && now.line.lineId !== this.#lastLineId) {
      this.#lastLineId = now.line.lineId;
      this.#device.setCaption(now.line.speaker, now.line.text);
    }
  }

  #onLink(state: LinkState): void {
    this.#shell.connectionEl.textContent = state === "open" ? "connected" : state;
    this.#shell.connectionEl.setAttribute("data-state", state);
    if (state === "closed") this.#notice("error", "The simulator host is not reachable. Retrying.");
  }

  #updateRing(): void {
    const state: RingState = this.#ptt ? "listening" : this.#playing ? "speaking" : this.#hostRing;
    this.#device.setRing(state);
  }

  #notice(level: "info" | "error", text: string): void {
    const node = this.#shell.noticeEl;
    node.textContent = text;
    node.setAttribute("data-level", level);
  }
}

/** The error boundary: an init failure shows a message instead of a blank page, and never the console. */
function renderFatal(root: HTMLElement, err: unknown): void {
  root.replaceChildren(
    el("div", { className: "fatal" }, [
      el("h1", { text: "Alexa+ simulator" }),
      el("p", { text: "The simulator could not start in this browser." }),
      el("p", { className: "fatal-detail", text: String(err) }),
    ]),
  );
}

function boot(): void {
  const root = document.getElementById("app");
  if (root === null) return;
  try {
    new App(root);
  } catch (err) {
    renderFatal(root, err);
  }
}

boot();
