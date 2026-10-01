import { describe, it, expect } from "vitest";
import { classifyUtterance } from "./intent.js";

describe("classifyUtterance", () => {
  const from = { partId: "p1", offsetMs: 12_000 };

  it("routes pause and resume to meta intents with no content call", () => {
    expect(classifyUtterance("pause for a moment").type).toBe("pause");
    expect(classifyUtterance("ok keep going").type).toBe("resume");
  });

  it("routes how-long questions to the local time-left intent", () => {
    const c = classifyUtterance("how long is left?", from);
    expect(c.type).toBe("time-left");
    if (c.type === "time-left") expect(c.positionSeconds).toBe(12);
  });

  it("routes skip and back to navigation, carrying the current position", () => {
    const skip = classifyUtterance("skip to the next part", from);
    expect(skip.type).toBe("skip");
    const back = classifyUtterance("go back a bit", from);
    expect(back.type).toBe("back");
    if (back.type === "back") expect(back.from).toEqual(from);
  });

  it("routes go deeper to an expansion and keeps the angle", () => {
    const c = classifyUtterance("go deeper on the dissent", from);
    expect(c.type).toBe("go-deeper");
    if (c.type === "go-deeper") expect(c.angle).toContain("dissent");
  });

  it("treats anything else as a question for the talent", () => {
    const c = classifyUtterance("what did they say about mortgages?", from);
    expect(c.type).toBe("ask");
    if (c.type === "ask") {
      expect(c.question).toContain("mortgages");
      expect(c.at).toEqual(from);
    }
  });
});
