import { describe, it, expect } from "vitest";
import { parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("rejects a non-object or an unknown type", () => {
    expect(parseCommand(null).ok).toBe(false);
    expect(parseCommand({ type: "nope" }).ok).toBe(false);
  });

  it("accepts a plan command and clamps minutes into range", () => {
    const r = parseCommand({
      type: "plan",
      source: { kind: "topic", value: "the Fed decision" },
      minutes: 99,
      format: "debate",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.command.type === "plan") {
      expect(r.command.minutes).toBe(15);
      expect(r.command.format).toBe("debate");
    }
  });

  it("rejects a plan with an empty source", () => {
    expect(parseCommand({ type: "plan", source: { kind: "text", value: "   " } }).ok).toBe(false);
  });

  it("drops an unknown format rather than failing the command", () => {
    const r = parseCommand({ type: "plan", source: { kind: "topic", value: "x" }, format: "jazz" });
    expect(r.ok).toBe(true);
    if (r.ok && r.command.type === "plan") expect(r.command.format).toBeUndefined();
  });

  it("parses a position on skip and omits it when malformed", () => {
    const good = parseCommand({ type: "skip", from: { partId: "p1", offsetMs: 500 } });
    expect(good.ok).toBe(true);
    if (good.ok && good.command.type === "skip")
      expect(good.command.from).toEqual({ partId: "p1", offsetMs: 500 });
    const bad = parseCommand({ type: "skip", from: { partId: "p1" } });
    if (bad.ok && bad.command.type === "skip") expect(bad.command.from).toBeUndefined();
  });

  it("requires a non-empty question for ask and caps its length", () => {
    expect(parseCommand({ type: "ask", question: "" }).ok).toBe(false);
    const long = parseCommand({ type: "ask", question: "a".repeat(1000) });
    if (long.ok && long.command.type === "ask")
      expect(long.command.question.length).toBeLessThanOrEqual(300);
  });
});
