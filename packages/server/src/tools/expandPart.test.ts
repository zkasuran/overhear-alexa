// expand_part: inserting a new part after its parent renumbers positions and keeps ids stable.

import { describe, it, expect } from "vitest";
import { insertAfter, transcriptUpTo } from "./expandPart.js";
import type { Line, Part } from "@overhear/core";

function part(index: number, status: Part["status"] = "ready", lines?: Line[]): Part {
  return {
    index,
    partId: `pt_${index}`,
    heading: `Part ${index}`,
    summary: `Summary ${index}`,
    estSeconds: 60,
    origin: "plan",
    status,
    ...(lines !== undefined ? { lines } : {}),
  };
}

describe("insertAfter", () => {
  it("inserts after the parent and renumbers, keeping ids stable", () => {
    const parts = [part(0), part(1), part(2)];
    const inserted: Part = {
      index: 99,
      partId: "pt_new",
      heading: "Deeper",
      summary: "More.",
      estSeconds: 70,
      origin: "expansion",
      expandsPartId: "pt_1",
      status: "ready",
    };
    const out = insertAfter(parts, "pt_1", inserted);

    expect(out.map((p) => p.partId)).toEqual(["pt_0", "pt_1", "pt_new", "pt_2"]);
    expect(out.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    const newPart = out.find((p) => p.partId === "pt_new");
    expect(newPart?.index).toBe(2);
    expect(newPart?.expandsPartId).toBe("pt_1");
  });

  it("appends when the parent is not found", () => {
    const parts = [part(0), part(1)];
    const inserted = { ...part(0), partId: "pt_x" };
    const out = insertAfter(parts, "pt_missing", inserted);
    expect(out.map((p) => p.partId)).toEqual(["pt_0", "pt_1", "pt_x"]);
    expect(out.map((p) => p.index)).toEqual([0, 1, 2]);
  });
});

describe("transcriptUpTo", () => {
  it("includes ready lines up to and including the parent part", () => {
    const parts = [
      part(0, "ready", [{ lineId: "ln_a", speaker: "host", text: "First." }]),
      part(1, "ready", [{ lineId: "ln_b", speaker: "expert", text: "Second." }]),
      part(2, "ready", [{ lineId: "ln_c", speaker: "host", text: "Third." }]),
    ];
    const transcript = transcriptUpTo(parts, 1);
    expect(transcript).toBe("host: First.\nexpert: Second.");
  });

  it("skips parts that are not ready", () => {
    const parts = [
      part(0, "ready", [{ lineId: "ln_a", speaker: "host", text: "First." }]),
      part(1, "scripting"),
    ];
    expect(transcriptUpTo(parts, 1)).toBe("host: First.");
  });
});
