// Deterministic text-model twin. No network, no AWS keys, no randomness: the same prompt always
// yields the same JSON, so the default test run and the judge demo both reproduce byte for byte.
// Output is shaped to pass the matching schema in schemas.ts after extractJson. Which prompt it is
// gets read off the fixed "Return JSON" instruction near the end of the prompt, never off the DATA
// block, so user text inside the source can never steer detection (prompt-injection safe, see
// SECURITY.md). Detection is one-part-at-a-time, matched to the six prompt builders in @overhear/core.

import {
  MAX_DEK_CHARS,
  MAX_LINE_CHARS,
  MAX_PARTS,
  MAX_TITLE_CHARS,
  PART0_TARGET_SECONDS,
  PART_MAX_SECONDS,
  PART_MIN_SECONDS,
} from "@overhear/core";
import type { PromptMessages } from "@overhear/core";
import type { Logger, ModelAdapter, ModelCallOpts } from "../../contracts.js";

/** Mock latency band, so render-ahead timing is visible in a demo. Computed from the input hash. */
export const MOCK_DELAY_MIN_MS = 150;
export const MOCK_DELAY_MAX_MS = 400;
const MOCK_DELAY_SPAN = MOCK_DELAY_MAX_MS - MOCK_DELAY_MIN_MS + 1;

type PromptKind = "plan" | "script" | "expand" | "ask" | "recap" | "find";
type Speaker = "host" | "expert";

// ---- deterministic hashing and small helpers ----

/** FNV-1a 32-bit. Stable across runs, enough spread to vary content and the delay. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], seed: number): T {
  const i = ((seed % arr.length) + arr.length) % arr.length;
  const v = arr[i];
  if (v === undefined) throw new Error("pick: empty pool");
  return v;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max).trimEnd();
}

function sentenceCase(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function firstWords(s: string, n: number): string {
  return s
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, n)
    .join(" ");
}

// prompts.ts wraps untrusted text as `<label> (DATA ONLY, ...):\n<<<DATA\n<text>\n DATA>>>`.
const DATA_OPEN = "<<<DATA\n";
const DATA_CLOSE = "\n DATA>>>";

/** The first DATA block in the prompt. For plan/script/expand/ask that is the SOURCE. */
function firstDataBlock(user: string): string {
  return dataBlockAt(user, user.indexOf(DATA_OPEN));
}

/** The DATA block for a named label, or "" when the prompt has no such block. */
function namedDataBlock(user: string, label: string): string {
  const at = user.indexOf(`${label} (DATA ONLY`);
  if (at === -1) return "";
  return dataBlockAt(user, user.indexOf(DATA_OPEN, at));
}

function dataBlockAt(user: string, open: number): string {
  if (open === -1) return "";
  const start = open + DATA_OPEN.length;
  const close = user.indexOf(DATA_CLOSE, start);
  if (close === -1) return "";
  return user.slice(start, close);
}

/** Classify the prompt off the fixed instruction line, never off the DATA block. */
function detectKind(user: string): PromptKind | null {
  const at = user.lastIndexOf("Return JSON");
  const spec = at >= 0 ? user.slice(at) : user;
  if (spec.includes('"parts"')) return "plan";
  if (spec.includes('"heading"') && spec.includes('"lines"')) return "expand";
  if (spec.includes('"lines"')) return "script";
  if (spec.includes('"answer"')) return "ask";
  if (spec.includes('"partId"')) return "find";
  if (spec.includes('"text"')) return "recap";
  return null;
}

// ---- content pools and extraction (coherent and on-topic-ish, fully deterministic) ----

const FALLBACK_TOPICS = ["this idea", "the topic", "today's subject", "the big question"] as const;
const HEADINGS = [
  "The big idea",
  "How it works",
  "Why it matters",
  "A closer look",
  "The surprising part",
  "What comes next",
  "Common myths",
  "The evidence",
] as const;
const SUMMARY_LEADS = [
  "A grounded look at",
  "The core claim behind",
  "What really drives",
  "The part people miss about",
  "A plain-English take on",
] as const;
const HOST_TEMPLATES = [
  "So let us start with {topic}. What should people know first?",
  "That is a great point about {heading}. Can you unpack it?",
  "Okay, so why does {topic} matter day to day?",
  "I did not expect that. Say more about {summary}.",
  "Let us slow down here. Walk me through {heading}.",
] as const;
const EXPERT_TEMPLATES = [
  "The short version is that {topic} is simpler than it looks once you see the pattern.",
  "Right. The key with {heading} is that the small details do the heavy lifting.",
  "Here is the part that surprised me. {summary} changes how you read the whole thing.",
  "Think of it this way. {topic} works because the pieces reinforce each other.",
  "Exactly. The evidence on {heading} is clearer than most people assume.",
] as const;

function fill(tmpl: string, v: { topic: string; heading: string; summary: string }): string {
  return tmpl
    .replaceAll("{topic}", v.topic)
    .replaceAll("{heading}", v.heading)
    .replaceAll("{summary}", v.summary);
}

/** A short topic phrase lifted from the SOURCE block, or a stable fallback. */
function topicFromSource(user: string, seed: number): string {
  const src = firstDataBlock(user).trim();
  if (src.length === 0) return pick(FALLBACK_TOPICS, seed);
  const topic = firstWords(src, 6)
    .replace(/[."]+$/, "")
    .trim();
  return topic.length > 0 ? clip(topic, 42) : pick(FALLBACK_TOPICS, seed);
}

/** 2 to 5 alternating lines, each 1..MAX_LINE_CHARS, starting on the host. */
function buildDialogue(
  seed: number,
  heading: string,
  summary: string,
  topic: string,
): { speaker: Speaker; text: string }[] {
  const hh = heading.length > 0 ? heading : topic;
  const ss = summary.length > 0 ? summary : topic;
  const count = 2 + (seed % 4);
  const lines: { speaker: Speaker; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    const speaker: Speaker = i % 2 === 0 ? "host" : "expert";
    const pool = speaker === "host" ? HOST_TEMPLATES : EXPERT_TEMPLATES;
    const text = clip(
      fill(pick(pool, seed + i * 31), { topic, heading: hh, summary: ss }),
      MAX_LINE_CHARS,
    );
    lines.push({ speaker, text: text.length > 0 ? text : topic });
  }
  return lines;
}

/** One verbatim-ish quote (1..200 chars) pulled from a transcript or source block. */
function pickQuote(text: string, seed: number): string {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const candidates = lines.length > 0 ? lines : [text.trim()].filter((l) => l.length > 0);
  if (candidates.length === 0) return "";
  const q = pick(candidates, seed).replace(/\s+/g, " ").trim();
  const capped = q.length > 200 ? q.slice(0, 200).trim() : q;
  return capped.length > 0 ? capped : "the episode";
}

/** partIds from the find-moment outline, where each line is `- <partId>: <heading> - <summary>`. */
function parsePartIds(user: string): string[] {
  const ids: string[] = [];
  const re = /^- ([^:\s]+):/gm;
  let m: RegExpExecArray | null = re.exec(user);
  while (m !== null) {
    const id = m[1];
    if (id !== undefined && id.length > 0) ids.push(id);
    m = re.exec(user);
  }
  return ids;
}

function planPartCount(user: string): number {
  const m = user.match(/plan about (\d+) parts/);
  const raw = m && m[1] !== undefined ? Number.parseInt(m[1], 10) : 4;
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, MAX_PARTS);
}

// ---- one builder per prompt kind; each returns an object that passes its schema ----

function buildPlan(user: string, seed: number): unknown {
  const topic = topicFromSource(user, seed);
  const n = planPartCount(user);
  const span = PART_MAX_SECONDS - PART_MIN_SECONDS + 1;
  const parts = Array.from({ length: n }, (_v, i) => {
    const heading = i === 0 ? "Cold open" : pick(HEADINGS, seed + i * 7);
    const summary =
      i === 0 ? `A quick hook into ${topic}.` : `${pick(SUMMARY_LEADS, seed + i * 13)} ${topic}.`;
    const estSeconds = i === 0 ? PART0_TARGET_SECONDS : PART_MIN_SECONDS + ((seed + i * 17) % span);
    return { heading, summary, estSeconds };
  });
  return {
    title: clip(`${sentenceCase(topic)} explained`, MAX_TITLE_CHARS),
    dek: clip(`A two-host conversation about ${topic}.`, MAX_DEK_CHARS),
    parts,
  };
}

function buildScript(user: string, seed: number): unknown {
  const m = user.match(/Write ONLY this part: "([^"]*)" - ([\s\S]*?)\. Aim for about/);
  const heading = m && m[1] !== undefined ? m[1] : "";
  const summary = m && m[2] !== undefined ? m[2] : "";
  const topic = topicFromSource(user, seed);
  return { lines: buildDialogue(seed, heading, summary, topic) };
}

function buildExpand(user: string, seed: number): unknown {
  const m = user.match(/go deeper on the part "([^"]*)"/);
  const topic = topicFromSource(user, seed);
  const base = m && m[1] !== undefined && m[1].length > 0 ? m[1] : topic;
  return {
    heading: clip(`More on ${base}`, 120),
    lines: buildDialogue(seed + 5, base, `going deeper on ${base}`, topic),
  };
}

function buildAsk(user: string, seed: number): unknown {
  const transcript = namedDataBlock(user, "EPISODE TRANSCRIPT").trim();
  const source = namedDataBlock(user, "SOURCE").trim();
  const grounded = transcript.length > 0 || source.length > 0;
  if (!grounded) {
    return {
      answer: "The episode did not cover that, so I cannot answer it from what we discussed.",
      grounded: false,
      citations: [],
    };
  }
  const quote = pickQuote(transcript.length > 0 ? transcript : source, seed);
  return {
    answer: clip(`Here is what the episode said about that. ${quote}`, 400),
    grounded: true,
    citations: quote.length > 0 ? [{ quote }] : [],
  };
}

function buildRecap(user: string, seed: number): unknown {
  const heard = namedDataBlock(user, "TRANSCRIPT HEARD SO FAR").trim();
  const topic = heard.length > 0 ? clip(firstWords(heard, 8), 60) : "the episode so far";
  const snippet = pickQuote(heard, seed);
  const lead = snippet.length > 0 ? `${snippet} ` : "";
  return { text: clip(`Quick recap. ${lead}That is the gist of ${topic}.`, 1000) };
}

function buildFind(user: string, seed: number): unknown {
  const ids = parsePartIds(user);
  const partId = ids.length > 0 ? pick(ids, seed) : "pt_unknown";
  const query = namedDataBlock(user, "LISTENER QUERY").trim();
  const reason =
    query.length > 0
      ? clip(`Best match for "${clip(query, 60)}".`, 200)
      : "Closest part to the query.";
  return { partId, confidence: 0.5 + (seed % 50) / 100, reason };
}

// ---- adapter ----

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("mock model call aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("mock model call aborted"));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Deterministic text model. `log` is optional and only used to flag an unknown prompt shape. */
export function makeMockModel(log?: Logger): ModelAdapter {
  return {
    id: "mock",
    async generate(messages: PromptMessages, opts?: ModelCallOpts): Promise<string> {
      const user = messages.user;
      const seed = hash32(`${messages.system} ${user}`);
      const kind = detectKind(user);
      await sleep(MOCK_DELAY_MIN_MS + (seed % MOCK_DELAY_SPAN), opts?.signal);
      if (kind === null) {
        log?.warn("mock model could not classify prompt");
        throw new Error("mock model: unrecognised prompt shape");
      }
      const out =
        kind === "plan"
          ? buildPlan(user, seed)
          : kind === "expand"
            ? buildExpand(user, seed)
            : kind === "script"
              ? buildScript(user, seed)
              : kind === "ask"
                ? buildAsk(user, seed)
                : kind === "find"
                  ? buildFind(user, seed)
                  : buildRecap(user, seed);
      return JSON.stringify(out);
    },
  };
}
