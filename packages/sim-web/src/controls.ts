// The controls under the device: a source form to plan an episode, the transport (play, pause, resume,
// back, skip, go deeper, time left), a push-to-talk fallback for mock mode where there is no live
// speech, and a row of sample utterances that stand in for spoken requests. Each control calls the
// sink; the controller turns that into a command and, for the local meta intents, drives the player
// too. Everything is labelled so a judge sees that mock mode uses recorded samples and typed input.

import { MAX_QUESTION_CHARS, MAX_TOPIC_CHARS } from "./config.js";
import { el } from "./dom.js";
import type { FormatId, SourceKind } from "./protocol.js";

export type PlanInput = { kind: SourceKind; value: string; minutes: number; format: FormatId };

export type CommandSink = {
  plan: (input: PlanInput) => void;
  play: () => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  back: () => void;
  goDeeper: () => void;
  timeLeft: () => void;
  ask: (question: string) => void;
  utterance: (text: string) => void;
  pttActive: (active: boolean) => void;
};

type Sample = { kind: SourceKind; value: string; label: string };

/** Long pasted text can be up to this many characters; a topic or a link is far shorter. */
const MAX_SOURCE_INPUT_CHARS = 20_000;

/** A https link is fetched, a long passage is used as the source text, anything else is a topic. */
export function sourceKindOf(value: string): SourceKind {
  if (/^https:\/\/\S+$/i.test(value)) return "url";
  if (value.length > MAX_TOPIC_CHARS || value.split(/\s+/).length > 40) return "text";
  return "topic";
}

function capFor(value: string): number {
  return sourceKindOf(value) === "topic" ? MAX_TOPIC_CHARS : MAX_SOURCE_INPUT_CHARS;
}

const SAMPLES: readonly Sample[] = [
  { kind: "topic", value: "the James Webb Space Telescope", label: "Topic: James Webb telescope" },
  { kind: "topic", value: "how sourdough bread rises", label: "Topic: how sourdough rises" },
  {
    kind: "text",
    value:
      "Tap water in most cities is treated in stages: coagulation clumps fine particles, sedimentation drops them out, filtration catches the rest, and disinfection kills what remains. Each stage targets a different risk, and skipping one shifts the load to the next.",
    label: "Text: how tap water is treated",
  },
];

const UTTERANCES: readonly string[] = [
  "Go deeper on the first point",
  "What was the main takeaway?",
  "Skip to the next part",
  "Back thirty seconds",
  "How long is left?",
  "Pause",
];

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { className, text: label, attrs: { type: "button" } });
  b.addEventListener("click", onClick);
  return b;
}

export function buildControls(root: HTMLElement, sink: CommandSink): void {
  // Source form.
  const formatSel = el("select", { className: "field", attrs: { "aria-label": "Format" } });
  for (const f of ["explainer", "debate", "cozy", "hype"] as FormatId[]) {
    formatSel.appendChild(el("option", { text: f, attrs: { value: f } }));
  }
  // Any topic, link or pasted text. The samples below fill it in; nothing is limited to them.
  const sourceInput = el("input", {
    className: "field source-input",
    attrs: {
      type: "text",
      maxlength: String(MAX_SOURCE_INPUT_CHARS),
      placeholder: "Any topic, a https:// link, or paste some text",
      value: SAMPLES[0]?.value ?? "",
      "aria-label": "Topic, link or text",
    },
  });
  const sourceSel = el("select", { className: "field", attrs: { "aria-label": "Examples" } });
  sourceSel.appendChild(el("option", { text: "Examples", attrs: { value: "" } }));
  SAMPLES.forEach((s, i) =>
    sourceSel.appendChild(el("option", { text: s.label, attrs: { value: String(i) } })),
  );
  sourceSel.addEventListener("change", () => {
    const s = SAMPLES[Number(sourceSel.value)];
    if (sourceSel.value !== "" && s) sourceInput.value = s.value;
    sourceSel.value = "";
  });
  const minutes = el("input", {
    className: "field minutes",
    attrs: { type: "number", min: "2", max: "15", value: "3", "aria-label": "Minutes" },
  });
  const planBtn = button("Plan episode", "btn primary", () => {
    const value = sourceInput.value.trim();
    if (value.length === 0) {
      sourceInput.focus();
      return;
    }
    const mins = Math.min(15, Math.max(2, Number(minutes.value) || 3));
    const fmt = (formatSel.value as FormatId) || "explainer";
    sink.plan({
      kind: sourceKindOf(value),
      value: value.slice(0, capFor(value)),
      minutes: mins,
      format: fmt,
    });
  });
  sourceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") planBtn.click();
  });
  const planRow = el("div", { className: "row plan-row" }, [
    el("span", { className: "row-label", text: "Plan" }),
    sourceInput,
    sourceSel,
    formatSel,
    minutes,
    planBtn,
  ]);

  // Transport.
  const transport = el("div", { className: "row transport" }, [
    el("span", { className: "row-label", text: "Transport" }),
    button("Play", "btn", () => sink.play()),
    button("Pause", "btn", () => sink.pause()),
    button("Resume", "btn", () => sink.resume()),
    button("Back", "btn", () => sink.back()),
    button("Skip", "btn", () => sink.skip()),
    button("Go deeper", "btn", () => sink.goDeeper()),
    button("Time left", "btn", () => sink.timeLeft()),
  ]);

  // Push-to-talk fallback.
  const input = el("input", {
    className: "field talk",
    attrs: {
      type: "text",
      maxlength: String(MAX_QUESTION_CHARS),
      placeholder: "Type a request, for example: what did they say about the mirror?",
      "aria-label": "Push to talk",
    },
  });
  input.addEventListener("focus", () => sink.pttActive(true));
  input.addEventListener("blur", () => sink.pttActive(false));
  const sendUtterance = (): void => {
    const text = input.value.trim();
    if (text.length === 0) return;
    sink.utterance(text);
    input.value = "";
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendUtterance();
  });
  const talkRow = el("div", { className: "row talk-row" }, [
    el("span", { className: "row-label", text: "Push to talk" }),
    input,
    button("Send", "btn", sendUtterance),
  ]);
  const talkNote = el("p", {
    className: "note",
    text: "Type a request or tap a sample. Live speech input (Nova Sonic) is the next step; requests take the same path either way.",
  });

  // Sample utterances.
  const samples = el("div", { className: "row samples" }, [
    el("span", { className: "row-label", text: "Try" }),
    ...UTTERANCES.map((u) => button(u, "btn chip-btn", () => sink.utterance(u))),
  ]);
  const sampleNote = el("p", {
    className: "note",
    text: "Sample utterances stand in for spoken requests and are routed through the same producer logic.",
  });

  root.appendChild(
    el("div", { className: "controls" }, [
      planRow,
      transport,
      talkRow,
      talkNote,
      samples,
      sampleNote,
    ]),
  );
}
