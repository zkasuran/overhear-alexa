// Validation for commands arriving from the browser. The browser is ours, but a WebSocket is still an
// untrusted boundary, so every field is checked and every string is capped before it reaches an MCP
// call (see SECURITY.md). An unparseable or oversized command is rejected with a reason rather than
// thrown, so one bad frame never takes the connection down.

import {
  MAX_ANGLE_CHARS,
  MAX_FOCUS_CHARS,
  MAX_QUESTION_CHARS,
  MAX_SOURCE_CHARS,
  MINUTES_MAX,
  MINUTES_MIN,
} from "@overhear/core";
import type { Command, FormatId, Position, SourceKind } from "./protocol.js";

const FORMATS: readonly FormatId[] = ["explainer", "debate", "cozy", "hype"];
const SOURCE_KINDS: readonly SourceKind[] = ["topic", "url", "text"];

/** A raw text source the UI can send without a model to seed the simulator. Capped like the server. */
const MAX_TEXT_VALUE = MAX_SOURCE_CHARS;
const MAX_TOPIC_VALUE = 400;
const MAX_URL_VALUE = 2048;

export type ParseResult = { ok: true; command: Command } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parsePosition(v: unknown): Position | undefined {
  if (!isRecord(v)) return undefined;
  const partId = str(v.partId);
  const offsetMs = typeof v.offsetMs === "number" ? v.offsetMs : undefined;
  if (partId === undefined || offsetMs === undefined || !Number.isFinite(offsetMs))
    return undefined;
  return { partId, offsetMs: Math.max(0, Math.floor(offsetMs)) };
}

/** Validate and normalise one raw frame into a Command, or explain why it was rejected. */
export function parseCommand(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, reason: "not an object" };
  const type = str(raw.type);
  if (type === undefined) return { ok: false, reason: "missing type" };

  switch (type) {
    case "plan": {
      const source = raw.source;
      if (!isRecord(source)) return { ok: false, reason: "plan: missing source" };
      const kind = str(source.kind);
      const value = str(source.value);
      if (kind === undefined || !SOURCE_KINDS.includes(kind as SourceKind)) {
        return { ok: false, reason: "plan: bad source kind" };
      }
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, reason: "plan: empty source" };
      }
      const cap =
        kind === "text" ? MAX_TEXT_VALUE : kind === "url" ? MAX_URL_VALUE : MAX_TOPIC_VALUE;
      if (value.length > cap) return { ok: false, reason: "plan: source too long" };
      const command: Command = {
        type: "plan",
        source: { kind: kind as SourceKind, value },
      };
      if (typeof raw.minutes === "number" && Number.isFinite(raw.minutes)) {
        command.minutes = Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(raw.minutes)));
      }
      const format = str(raw.format);
      if (format !== undefined && FORMATS.includes(format as FormatId)) {
        command.format = format as FormatId;
      }
      const focus = str(raw.focus);
      if (focus !== undefined && focus.trim().length > 0) {
        command.focus = focus.slice(0, MAX_FOCUS_CHARS);
      }
      return { ok: true, command };
    }
    case "play":
      return { ok: true, command: { type: "play" } };
    case "pause":
      return { ok: true, command: { type: "pause" } };
    case "resume":
      return { ok: true, command: { type: "resume" } };
    case "skip": {
      const from = parsePosition(raw.from);
      return { ok: true, command: from ? { type: "skip", from } : { type: "skip" } };
    }
    case "back": {
      const from = parsePosition(raw.from);
      return { ok: true, command: from ? { type: "back", from } : { type: "back" } };
    }
    case "go-deeper": {
      const command: Command = { type: "go-deeper" };
      const from = parsePosition(raw.from);
      if (from) command.from = from;
      const angle = str(raw.angle);
      if (angle !== undefined && angle.trim().length > 0)
        command.angle = angle.slice(0, MAX_ANGLE_CHARS);
      return { ok: true, command };
    }
    case "ask": {
      const question = str(raw.question);
      if (question === undefined || question.trim().length === 0) {
        return { ok: false, reason: "ask: empty question" };
      }
      const command: Command = { type: "ask", question: question.slice(0, MAX_QUESTION_CHARS) };
      const at = parsePosition(raw.at);
      if (at) command.at = at;
      return { ok: true, command };
    }
    case "time-left": {
      const positionSeconds =
        typeof raw.positionSeconds === "number" && Number.isFinite(raw.positionSeconds)
          ? Math.max(0, raw.positionSeconds)
          : 0;
      return { ok: true, command: { type: "time-left", positionSeconds } };
    }
    case "utterance": {
      const text = str(raw.text);
      if (text === undefined || text.trim().length === 0) {
        return { ok: false, reason: "utterance: empty text" };
      }
      const command: Command = { type: "utterance", text: text.slice(0, MAX_QUESTION_CHARS) };
      const from = parsePosition(raw.from);
      if (from) command.from = from;
      return { ok: true, command };
    }
    default:
      return { ok: false, reason: `unknown command: ${type}` };
  }
}
