// Turn a free-text utterance into a command, the way the producer routes a spoken request. This is the
// bridge's deterministic classifier: meta intents (pause, resume, skip, back, time left) resolve here
// with no model and no content call, and everything else is treated as a question for the talent. It is
// pure and keyword based on purpose, so a demo without cloud speech still shows the producer-vs-talent
// split that a live Sonic session would make.

import type { Command, Position } from "./protocol.js";

function has(text: string, words: readonly string[]): boolean {
  return words.some((w) => text.includes(w));
}

/**
 * Classify an utterance. `from` is the listener's current position, needed for a relative move. The
 * result is a command the bridge already knows how to run; the classification itself is the routing.
 */
export function classifyUtterance(text: string, from?: Position): Command {
  const q = text.toLowerCase().trim().replace(/\s+/g, " ");

  if (has(q, ["pause", "hold on", "wait", "stop for a sec", "hang on"])) {
    return { type: "pause" };
  }
  if (has(q, ["resume", "keep going", "carry on", "unpause", "continue", "play on"])) {
    return { type: "resume" };
  }
  if (has(q, ["how long", "time left", "how much is left", "how much time", "minutes left"])) {
    return { type: "time-left", positionSeconds: Math.round((from?.offsetMs ?? 0) / 1000) };
  }
  if (
    has(q, ["go deeper", "dig in", "expand", "more detail", "more on", "tell me more", "unpack"])
  ) {
    const angle = q.replace(/^(go deeper|dig in|expand|unpack)\b/, "").trim();
    const command: Command = { type: "go-deeper" };
    if (from) command.from = from;
    if (angle.length > 0) command.angle = angle;
    return command;
  }
  // Back must be checked before skip, since "go back" also contains no skip words but "skip back" could.
  if (has(q, ["back", "rewind", "previous", "go back", "repeat that", "earlier"])) {
    return from ? { type: "back", from } : { type: "back" };
  }
  if (has(q, ["skip", "next", "move on", "ahead", "forward"])) {
    return from ? { type: "skip", from } : { type: "skip" };
  }
  // Default: a content question for the talent.
  const command: Command = { type: "ask", question: text.trim() };
  if (from) command.at = from;
  return command;
}
