// The WebSocket wire protocol between the browser device UI and the simulator host.
//
// Commands travel up (browser to host); events travel down (host to browser). Both are JSON objects
// discriminated by `type`. This file is pure type declarations with no imports, so the same shapes can
// be declared on both ends without pulling host code into the browser bundle. The browser-side copy is
// kept identical; validation of incoming messages lives beside each end, never here.

export type FormatId = "explainer" | "debate" | "cozy" | "hype";
export type PartStatus = "pending" | "scripting" | "voicing" | "mixing" | "ready" | "failed";
export type PartOrigin = "plan" | "expansion";
export type Speaker = "host" | "expert";
export type CaptionVoice = "host" | "expert" | "producer";
export type RingState = "idle" | "listening" | "thinking" | "speaking";
export type SourceKind = "topic" | "url" | "text";

export type Position = { partId: string; offsetMs: number };

/** One outline beat as the browser needs it: identity, position, heading, estimate and current status. */
export type OutlinePart = {
  index: number;
  partId: string;
  heading: string;
  summary: string;
  estSeconds: number;
  status: PartStatus;
  origin: PartOrigin;
};

export type AudioRef = { url: string; seconds: number };

export type Citation = { partId: string; lineId: string; quote: string };

/** One scripted line with the timings the mix recorded, used to drive synced captions in the browser. */
export type CaptionLine = {
  lineId: string;
  speaker: Speaker;
  text: string;
  startMs?: number;
  endMs?: number;
};

// Commands: browser to host.

export type PlanCommand = {
  type: "plan";
  source: { kind: SourceKind; value: string };
  minutes?: number;
  format?: FormatId;
  focus?: string;
};
export type PlayCommand = { type: "play" };
export type PauseCommand = { type: "pause" };
export type ResumeCommand = { type: "resume" };
export type SkipCommand = { type: "skip"; from?: Position };
export type BackCommand = { type: "back"; from?: Position };
export type GoDeeperCommand = { type: "go-deeper"; from?: Position; angle?: string };
export type AskCommand = { type: "ask"; question: string; at?: Position };
export type TimeLeftCommand = { type: "time-left"; positionSeconds: number };
export type UtteranceCommand = { type: "utterance"; text: string; from?: Position };

export type Command =
  | PlanCommand
  | PlayCommand
  | PauseCommand
  | ResumeCommand
  | SkipCommand
  | BackCommand
  | GoDeeperCommand
  | AskCommand
  | TimeLeftCommand
  | UtteranceCommand;

export type CommandType = Command["type"];

// Events: host to browser.

export type StatusEvent = {
  type: "status";
  mode: "mock" | "aws";
  store: "local" | "aws";
  producer: "sonic" | "push-to-talk";
  serverOk: boolean;
  label: string;
};
export type RingEvent = { type: "ring"; state: RingState };
export type OutlineEvent = {
  type: "outline";
  episodeId: string;
  title: string;
  dek: string;
  format: FormatId;
  parts: OutlinePart[];
  totalEstSeconds: number;
  speakable: string;
};
export type PartStatusEvent = {
  type: "part-status";
  partId: string;
  index: number;
  status: PartStatus;
  heading: string;
};
export type PartReadyEvent = {
  type: "part-ready";
  partId: string;
  index: number;
  heading: string;
  origin: PartOrigin;
  audio: AudioRef;
  lines?: CaptionLine[];
};
export type CaptionEvent = {
  type: "caption";
  speaker: CaptionVoice;
  text: string;
  partId?: string;
};
export type DuckingEvent = { type: "ducking"; active: boolean };
export type AnswerEvent = {
  type: "answer";
  question: string;
  answer: string;
  speaker: Speaker;
  grounded: boolean;
  citations: Citation[];
  audio?: AudioRef;
};
export type MomentEvent = {
  type: "moment";
  intent: "skip" | "back";
  partId: string;
  index: number;
  offsetMs: number;
  heading: string;
  confidence: number;
  reason: string;
};
export type TimeLeftEvent = {
  type: "time-left";
  elapsedSeconds: number;
  remainingSeconds: number;
  totalSeconds: number;
  speakable: string;
};
export type NoticeEvent = { type: "notice"; level: "info" | "error"; text: string };
export type RenderDoneEvent = { type: "render-done"; episodeId: string; totalSeconds: number };

export type Event =
  | StatusEvent
  | RingEvent
  | OutlineEvent
  | PartStatusEvent
  | PartReadyEvent
  | CaptionEvent
  | DuckingEvent
  | AnswerEvent
  | MomentEvent
  | TimeLeftEvent
  | NoticeEvent
  | RenderDoneEvent;

export type EventType = Event["type"];
