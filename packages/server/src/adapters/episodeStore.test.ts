// Acceptance tests for the SQLite EpisodeStore (the local twin). Run against an in-memory database,
// so no files are written and each test starts clean. The DynamoDB adapter is not exercised here:
// it needs real AWS credentials and a table, so any live check is gated behind OVERHEAR_LIVE_TESTS.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Episode, Part } from "@overhear/core";
import type { EpisodeStore, Logger } from "../contracts.js";
import { makeSqliteEpisodeStore } from "./episodeStore.sqlite.js";

function makeLog(): Logger {
  const log: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
}

function part(index: number, partId: string, withLines = true): Part {
  const base: Part = {
    index,
    partId,
    heading: `Part ${index}`,
    summary: `Summary ${index}`,
    estSeconds: 60,
    origin: "plan",
    status: "ready",
  };
  return withLines
    ? { ...base, lines: [{ lineId: `ln_${partId}`, speaker: "host", text: "hello" }] }
    : base;
}

function episode(opts: {
  id: string;
  principal: string;
  createdAt?: string;
  title?: string;
  status?: Episode["status"];
  parts?: Part[];
}): Episode {
  const at = opts.createdAt ?? "2026-01-01T00:00:00.000Z";
  return {
    id: opts.id,
    principal: opts.principal,
    title: opts.title ?? "Title",
    dek: "Dek",
    format: "explainer",
    targetSeconds: 600,
    status: opts.status ?? "planned",
    parts: opts.parts ?? [part(0, `${opts.id}-p0`)],
    sourceKind: "topic",
    createdAt: at,
    updatedAt: at,
  };
}

let store: EpisodeStore;

beforeEach(() => {
  store = makeSqliteEpisodeStore(":memory:", makeLog());
});

afterEach(async () => {
  await store.close();
});

describe("sqlite episode store: ownership and reads", () => {
  it("createEpisode then getEpisode returns it to the owner, with its parts", async () => {
    const ep = episode({ id: "ep_a", principal: "alice", parts: [part(0, "p0"), part(1, "p1")] });
    await store.createEpisode(ep, "the source text");
    const got = await store.getEpisode("alice", "ep_a");
    expect(got).toEqual(ep);
  });

  it("getEpisode for a foreign principal returns null", async () => {
    await store.createEpisode(episode({ id: "ep_a", principal: "alice" }), "src");
    expect(await store.getEpisode("mallory", "ep_a")).toBeNull();
  });

  it("getEpisode for a missing episode returns null", async () => {
    expect(await store.getEpisode("alice", "ep_missing")).toBeNull();
  });

  it("getSource returns to the owner and null to a foreign principal", async () => {
    await store.createEpisode(episode({ id: "ep_a", principal: "alice" }), "secret source");
    expect(await store.getSource("alice", "ep_a")).toBe("secret source");
    expect(await store.getSource("mallory", "ep_a")).toBeNull();
  });
});

describe("sqlite episode store: parts", () => {
  it("putPart adds a part that getEpisode then shows, in index order", async () => {
    await store.createEpisode(
      episode({ id: "ep_a", principal: "alice", parts: [part(0, "p0")] }),
      "src",
    );
    await store.putPart("alice", "ep_a", part(1, "p1"));
    const got = await store.getEpisode("alice", "ep_a");
    expect(got?.parts.map((p) => p.partId)).toEqual(["p0", "p1"]);
  });

  it("putPart from a foreign principal is a no-op", async () => {
    await store.createEpisode(
      episode({ id: "ep_a", principal: "alice", parts: [part(0, "p0")] }),
      "src",
    );
    await store.putPart("mallory", "ep_a", part(1, "p1"));
    const got = await store.getEpisode("alice", "ep_a");
    expect(got?.parts).toHaveLength(1);
  });

  it("putPart upserts an existing part id rather than duplicating it", async () => {
    await store.createEpisode(
      episode({ id: "ep_a", principal: "alice", parts: [part(0, "p0")] }),
      "src",
    );
    await store.putPart("alice", "ep_a", { ...part(0, "p0"), heading: "Rewritten" });
    const got = await store.getEpisode("alice", "ep_a");
    expect(got?.parts).toHaveLength(1);
    expect(got?.parts[0]?.heading).toBe("Rewritten");
  });
});

describe("sqlite episode store: patch", () => {
  it("patchEpisode updates status and title and leaves other fields alone", async () => {
    await store.createEpisode(episode({ id: "ep_a", principal: "alice", title: "Old" }), "src");
    await store.patchEpisode("alice", "ep_a", { status: "ready", title: "New" });
    const got = await store.getEpisode("alice", "ep_a");
    expect(got?.status).toBe("ready");
    expect(got?.title).toBe("New");
    expect(got?.dek).toBe("Dek");
  });

  it("patchEpisode merges a replacement parts array", async () => {
    await store.createEpisode(
      episode({ id: "ep_a", principal: "alice", parts: [part(0, "p0")] }),
      "src",
    );
    await store.patchEpisode("alice", "ep_a", { parts: [part(0, "p0"), part(1, "p1")] });
    const got = await store.getEpisode("alice", "ep_a");
    expect(got?.parts.map((p) => p.partId)).toEqual(["p0", "p1"]);
  });

  it("patchEpisode for a foreign principal is a no-op", async () => {
    await store.createEpisode(episode({ id: "ep_a", principal: "alice", title: "Old" }), "src");
    await store.patchEpisode("mallory", "ep_a", { title: "Hijacked" });
    const got = await store.getEpisode("alice", "ep_a");
    expect(got?.title).toBe("Old");
  });
});

describe("sqlite episode store: listByPrincipal", () => {
  it("returns manifests newest first, without lines or principal, scoped to the principal", async () => {
    await store.createEpisode(
      episode({ id: "ep_old", principal: "alice", createdAt: "2026-01-01T00:00:00.000Z" }),
      "src",
    );
    await store.createEpisode(
      episode({ id: "ep_new", principal: "alice", createdAt: "2026-01-03T00:00:00.000Z" }),
      "src",
    );
    await store.createEpisode(
      episode({ id: "ep_bob", principal: "bob", createdAt: "2026-01-02T00:00:00.000Z" }),
      "src",
    );

    const list = await store.listByPrincipal("alice", 10);
    expect(list.map((m) => m.id)).toEqual(["ep_new", "ep_old"]);
    for (const m of list) {
      expect(m).not.toHaveProperty("principal");
      expect(m.parts.length).toBeGreaterThan(0);
      for (const p of m.parts) expect(p).not.toHaveProperty("lines");
    }
  });

  it("honours the limit", async () => {
    await store.createEpisode(
      episode({ id: "ep_1", principal: "alice", createdAt: "2026-01-01T00:00:00.000Z" }),
      "s",
    );
    await store.createEpisode(
      episode({ id: "ep_2", principal: "alice", createdAt: "2026-01-02T00:00:00.000Z" }),
      "s",
    );
    const list = await store.listByPrincipal("alice", 1);
    expect(list.map((m) => m.id)).toEqual(["ep_2"]);
  });
});

describe("sqlite episode store: countEpisodesSince", () => {
  it("counts episodes with created_at at or after the boundary", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-02T00:00:00.000Z";
    const t3 = "2026-01-03T00:00:00.000Z";
    await store.createEpisode(episode({ id: "ep_1", principal: "alice", createdAt: t1 }), "s");
    await store.createEpisode(episode({ id: "ep_2", principal: "alice", createdAt: t2 }), "s");
    await store.createEpisode(episode({ id: "ep_3", principal: "alice", createdAt: t3 }), "s");
    await store.createEpisode(episode({ id: "ep_b", principal: "bob", createdAt: t3 }), "s");

    expect(await store.countEpisodesSince("alice", t1)).toBe(3);
    expect(await store.countEpisodesSince("alice", t2)).toBe(2); // boundary is inclusive
    expect(await store.countEpisodesSince("alice", "2026-01-04T00:00:00.000Z")).toBe(0);
    expect(await store.countEpisodesSince("bob", t1)).toBe(1);
  });
});
