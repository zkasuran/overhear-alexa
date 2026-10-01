// find_moment: deterministic navigation parsing and timeline math (no model), plus the semantic path.

import { describe, it, expect } from "vitest";
import { parseNav, resolveRelative, runFindMoment } from "./findMoment.js";
import type { Services } from "../contracts.js";
import type { Episode, Part } from "@overhear/core";

function part(index: number, estSeconds: number, status: Part["status"] = "ready"): Part {
  return {
    index,
    partId: `pt_${index}`,
    heading: `Part ${index}`,
    summary: `Summary ${index}`,
    estSeconds,
    origin: "plan",
    status,
  };
}

const PARTS: Part[] = [part(0, 30), part(1, 90), part(2, 120)];

function makeEpisode(parts: Part[] = PARTS): Episode {
  return {
    id: "ep_test",
    principal: "user-1",
    title: "Test episode",
    dek: "A test.",
    format: "explainer",
    targetSeconds: 240,
    status: "ready",
    parts,
    sourceKind: "topic",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("parseNav", () => {
  it("reads relative-time moves with digits and spelled numbers", () => {
    expect(parseNav("back 30 seconds")).toEqual({ kind: "seconds", ms: 30_000, direction: -1 });
    expect(parseNav("rewind thirty seconds")).toEqual({
      kind: "seconds",
      ms: 30_000,
      direction: -1,
    });
    expect(parseNav("forward 15 seconds")).toEqual({ kind: "seconds", ms: 15_000, direction: 1 });
    expect(parseNav("skip 45 seconds")).toEqual({ kind: "seconds", ms: 45_000, direction: 1 });
    expect(parseNav("go back a minute")).toEqual({ kind: "seconds", ms: 60_000, direction: -1 });
  });

  it("reads part moves and restart", () => {
    expect(parseNav("next")).toEqual({ kind: "part", direction: 1 });
    expect(parseNav("next part")).toEqual({ kind: "part", direction: 1 });
    expect(parseNav("skip this")).toEqual({ kind: "part", direction: 1 });
    expect(parseNav("go back")).toEqual({ kind: "part", direction: -1 });
    expect(parseNav("previous part")).toEqual({ kind: "part", direction: -1 });
    expect(parseNav("start over")).toEqual({ kind: "restart" });
  });

  it("returns null for a semantic query", () => {
    expect(parseNav("the history bit")).toBeNull();
    expect(parseNav("where they talked about dissent")).toBeNull();
    expect(parseNav("the next big idea they mentioned")).toBeNull();
  });
});

describe("resolveRelative", () => {
  it("moves back across a part boundary and clamps at zero", () => {
    const back = resolveRelative(
      PARTS,
      { kind: "seconds", ms: 30_000, direction: -1 },
      {
        partId: "pt_1",
        offsetMs: 10_000,
      },
    );
    expect(back).not.toBeNull();
    expect(back?.index).toBe(0);
    expect(back?.offsetMs).toBe(10_000);

    const floored = resolveRelative(
      PARTS,
      { kind: "seconds", ms: 999_000, direction: -1 },
      {
        partId: "pt_0",
        offsetMs: 0,
      },
    );
    expect(floored?.index).toBe(0);
    expect(floored?.offsetMs).toBe(0);
  });

  it("moves forward within a part and jumps whole parts", () => {
    const fwd = resolveRelative(
      PARTS,
      { kind: "seconds", ms: 15_000, direction: 1 },
      {
        partId: "pt_0",
        offsetMs: 0,
      },
    );
    expect(fwd?.index).toBe(0);
    expect(fwd?.offsetMs).toBe(15_000);

    const next = resolveRelative(
      PARTS,
      { kind: "part", direction: 1 },
      { partId: "pt_0", offsetMs: 0 },
    );
    expect(next?.index).toBe(1);
    expect(next?.offsetMs).toBe(0);

    const restart = resolveRelative(
      PARTS,
      { kind: "restart" },
      { partId: "pt_2", offsetMs: 5_000 },
    );
    expect(restart?.index).toBe(0);
    expect(restart?.offsetMs).toBe(0);
  });

  it("clamps a forward move to the end of the episode", () => {
    const end = resolveRelative(
      PARTS,
      { kind: "seconds", ms: 999_000, direction: 1 },
      {
        partId: "pt_2",
        offsetMs: 0,
      },
    );
    expect(end?.index).toBe(2);
    expect(end?.offsetMs).toBe(120_000);
  });
});

function fakeServices(episode: Episode | null, modelJson: string): Services {
  const base = {
    async getEpisode(_p: string, _id: string) {
      return episode;
    },
  } as unknown as Services["episodes"];
  return {
    episodes: base,
    model: {
      id: "fake",
      async generate() {
        return modelJson;
      },
    },
    now: () => 1_700_000_000_000,
  } as unknown as Services;
}

describe("runFindMoment semantic path", () => {
  it("resolves a semantic query through the model to a part", async () => {
    const services = fakeServices(
      makeEpisode(),
      JSON.stringify({ partId: "pt_1", confidence: 0.8, reason: "the middle part" }),
    );
    const result = await runFindMoment(services, "user-1", {
      episodeId: "ep_test",
      query: "the part about the hard middle",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.partId).toBe("pt_1");
    expect(result.structuredContent?.index).toBe(1);
    expect(result.structuredContent?.confidence).toBe(0.8);
  });

  it("is a spoken error for an unknown episode", async () => {
    const services = fakeServices(null, "{}");
    const result = await runFindMoment(services, "user-1", { episodeId: "nope", query: "the bit" });
    expect(result.isError).toBe(true);
  });
});
