// The Echo Show style device frame: the ring light, the episode header, the live captions, the outline
// with the playing part highlighted, and the elapsed and remaining readout. It owns only its own DOM
// and exposes typed update methods; the controller decides when to call them. "Alexa+ simulator" is
// shown at all times, and the run mode is labelled so a recorded sample is never mistaken for live.

import { clear, el, setText } from "./dom.js";
import type { CaptionVoice, OutlineEvent, PartStatus, RingState } from "./protocol.js";

const STATUS_LABEL: Record<PartStatus, string> = {
  pending: "queued",
  scripting: "writing",
  voicing: "voicing",
  mixing: "mixing",
  ready: "ready",
  failed: "failed",
};

const SPEAKER_LABEL: Record<CaptionVoice, string> = {
  host: "Host",
  expert: "Expert",
  producer: "Alexa+",
};

function fmtTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export class DeviceView {
  readonly #ring: HTMLElement;
  readonly #ringLabel: HTMLElement;
  readonly #title: HTMLElement;
  readonly #dek: HTMLElement;
  readonly #capSpeaker: HTMLElement;
  readonly #capText: HTMLElement;
  readonly #outline: HTMLElement;
  readonly #bar: HTMLElement;
  readonly #elapsed: HTMLElement;
  readonly #remaining: HTMLElement;
  readonly #modeBadge: HTMLElement;
  readonly #rows = new Map<string, { li: HTMLElement; chip: HTMLElement }>();

  constructor(root: HTMLElement) {
    this.#ringLabel = el("span", { className: "ring-label", text: "idle" });
    this.#ring = el("div", { className: "ring", attrs: { "data-state": "idle" } }, [
      this.#ringLabel,
    ]);

    this.#modeBadge = el("span", { className: "badge", text: "connecting" });
    const wordmark = el("div", { className: "wordmark" }, [
      el("span", { className: "mark", text: "Alexa+ simulator" }),
      this.#modeBadge,
    ]);

    this.#title = el("h1", { className: "ep-title", text: "No episode yet" });
    this.#dek = el("p", { className: "ep-dek", text: "Plan an episode to begin." });

    this.#capSpeaker = el("span", { className: "cap-speaker", text: "" });
    this.#capText = el("span", {
      className: "cap-text",
      text: "Captions appear here as the episode plays.",
    });
    const captions = el("div", { className: "captions", attrs: { "aria-live": "polite" } }, [
      this.#capSpeaker,
      this.#capText,
    ]);

    this.#outline = el("ol", { className: "outline" });

    this.#bar = el("div", { className: "bar-fill" });
    const barTrack = el("div", { className: "bar-track" }, [this.#bar]);
    this.#elapsed = el("span", { className: "t-elapsed", text: "0:00" });
    this.#remaining = el("span", { className: "t-remaining", text: "0:00" });
    const meta = el("div", { className: "transport-meta" }, [
      this.#elapsed,
      barTrack,
      this.#remaining,
    ]);

    const screen = el("div", { className: "screen" }, [
      wordmark,
      el("div", { className: "ep-head" }, [this.#title, this.#dek]),
      captions,
      this.#outline,
      meta,
    ]);
    const device = el(
      "section",
      { className: "device", attrs: { "aria-label": "Alexa+ simulator device" } },
      [this.#ring, screen],
    );
    root.appendChild(device);
  }

  setRing(state: RingState): void {
    this.#ring.setAttribute("data-state", state);
    setText(this.#ringLabel, state);
  }

  setMode(label: string): void {
    setText(this.#modeBadge, label);
  }

  setOutline(ev: OutlineEvent): void {
    setText(this.#title, ev.title.length > 0 ? ev.title : "Episode");
    setText(this.#dek, ev.dek);
    clear(this.#outline);
    this.#rows.clear();
    for (const part of ev.parts) {
      const chip = el("span", { className: "chip", text: STATUS_LABEL[part.status] });
      chip.setAttribute("data-status", part.status);
      const head = el("span", { className: "o-head", text: `${part.index + 1}. ${part.heading}` });
      const li = el("li", { className: "o-row" }, [head, chip]);
      if (part.origin === "expansion") li.classList.add("expansion");
      this.#outline.appendChild(li);
      this.#rows.set(part.partId, { li, chip });
    }
  }

  setPartStatus(partId: string, status: PartStatus): void {
    const row = this.#rows.get(partId);
    if (row === undefined) return;
    setText(row.chip, STATUS_LABEL[status]);
    row.chip.setAttribute("data-status", status);
  }

  markPlaying(partId: string): void {
    for (const [id, row] of this.#rows) row.li.classList.toggle("playing", id === partId);
  }

  setCaption(speaker: CaptionVoice, text: string): void {
    setText(this.#capSpeaker, SPEAKER_LABEL[speaker]);
    this.#capSpeaker.setAttribute("data-voice", speaker);
    setText(this.#capText, text);
  }

  setProgress(elapsedSeconds: number, totalSeconds: number): void {
    const pct = totalSeconds > 0 ? Math.min(100, (elapsedSeconds / totalSeconds) * 100) : 0;
    this.#bar.style.width = `${pct}%`;
    setText(this.#elapsed, fmtTime(elapsedSeconds));
    setText(this.#remaining, `-${fmtTime(Math.max(0, totalSeconds - elapsedSeconds))}`);
  }
}
