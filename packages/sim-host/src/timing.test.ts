import { describe, it, expect } from "vitest";
import { computeTimeLeft } from "./timing.js";
import { proxyAudioUrl, mediaTokenOf } from "./media-proxy.js";

describe("computeTimeLeft", () => {
  it("reports remaining time and clamps the position into the episode", () => {
    const tl = computeTimeLeft(30, 150);
    expect(tl.elapsedSeconds).toBe(30);
    expect(tl.remainingSeconds).toBe(120);
    expect(tl.totalSeconds).toBe(150);
  });

  it("never goes negative past the end", () => {
    const tl = computeTimeLeft(500, 150);
    expect(tl.remainingSeconds).toBe(0);
    expect(tl.speakable).toContain("end");
  });
});

describe("proxyAudioUrl", () => {
  it("rewrites a relative media path onto the host base", () => {
    expect(proxyAudioUrl("/media/abc", "http://127.0.0.1:8788")).toBe(
      "http://127.0.0.1:8788/media/abc",
    );
  });

  it("passes an absolute url through unchanged", () => {
    const presigned = "https://bucket.s3.amazonaws.com/x?sig=1";
    expect(proxyAudioUrl(presigned, "http://127.0.0.1:8788")).toBe(presigned);
  });
});

describe("mediaTokenOf", () => {
  it("extracts a well-formed token and rejects anything else", () => {
    expect(mediaTokenOf("/media/Ab09_-")).toBe("Ab09_-");
    expect(mediaTokenOf("/media/../etc/passwd")).toBeNull();
    expect(mediaTokenOf("/other")).toBeNull();
  });
});
