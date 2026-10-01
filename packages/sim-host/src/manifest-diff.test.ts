import { describe, it, expect } from "vitest";
import { diffManifest } from "./manifest-diff.js";
import type { ManifestPart } from "./mcp-client.js";

function part(
  partId: string,
  index: number,
  status: ManifestPart["status"],
  withAudio = false,
): ManifestPart {
  const p: ManifestPart = {
    partId,
    index,
    heading: partId,
    summary: "",
    estSeconds: 30,
    origin: "plan",
    status,
  };
  if (withAudio) p.audio = { url: `/media/${partId}`, seconds: 30 };
  return p;
}

describe("diffManifest", () => {
  it("reports a part that changed status and leaves unchanged parts alone", () => {
    const last = new Map([
      ["a", "scripting"],
      ["b", "pending"],
    ]);
    const diff = diffManifest(last, new Set(), [
      part("a", 0, "ready", true),
      part("b", 1, "pending"),
    ]);
    expect(diff.statusChanged.map((p) => p.partId)).toEqual(["a"]);
    expect(diff.newParts).toHaveLength(0);
  });

  it("reports a part as newly ready only once", () => {
    const parts = [part("a", 0, "ready", true)];
    const first = diffManifest(new Map([["a", "mixing"]]), new Set(), parts);
    expect(first.newlyReady.map((p) => p.partId)).toEqual(["a"]);
    const second = diffManifest(new Map([["a", "ready"]]), new Set(["a"]), parts);
    expect(second.newlyReady).toHaveLength(0);
  });

  it("does not mark a ready part playable until it has audio", () => {
    const diff = diffManifest(new Map(), new Set(), [part("a", 0, "ready", false)]);
    expect(diff.newlyReady).toHaveLength(0);
  });

  it("flags an inserted part as new", () => {
    const diff = diffManifest(new Map([["a", "ready"]]), new Set(["a"]), [
      part("a", 0, "ready", true),
      part("exp", 1, "ready", true),
    ]);
    expect(diff.newParts.map((p) => p.partId)).toEqual(["exp"]);
  });
});
