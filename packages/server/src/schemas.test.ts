import { MAX_LINE_CHARS, MAX_LINES_PER_PART } from "@overhear/core";
import { describe, expect, it } from "vitest";
import { AskModelOutput, ScriptModelOutput, clampText } from "./schemas.js";

describe("model-output clamping", () => {
  it("cuts at a word boundary and never exceeds the cap", () => {
    const s = "the mirror has eighteen gold coated hexagonal segments that unfold in space";
    const out = clampText(s, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(s.startsWith(out)).toBe(true);
    expect(out.endsWith(" ")).toBe(false);
    expect(clampText("short", 30)).toBe("short");
  });

  it("clamps an over-long citation instead of failing the answer", () => {
    const quote = "x ".repeat(150).trim();
    const parsed = AskModelOutput.parse({ answer: "a", grounded: true, citations: [{ quote }] });
    expect(parsed.citations[0]?.quote.length).toBeLessThanOrEqual(200);
    expect(quote.startsWith(parsed.citations[0]?.quote ?? "?")).toBe(true);
  });

  it("trims too many lines and too-long lines, still rejects a wrong speaker", () => {
    const line = { speaker: "host", text: "word ".repeat(MAX_LINE_CHARS) };
    const many = Array.from({ length: MAX_LINES_PER_PART + 5 }, () => line);
    const parsed = ScriptModelOutput.parse({ lines: many });
    expect(parsed.lines).toHaveLength(MAX_LINES_PER_PART);
    expect(parsed.lines[0]?.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(() =>
      ScriptModelOutput.parse({ lines: [{ speaker: "narrator", text: "hi" }] }),
    ).toThrow();
  });
});
