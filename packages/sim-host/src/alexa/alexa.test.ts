import { describe, expect, it } from "vitest";
import type { Manifest, ManifestPart } from "../mcp-client.js";
import { makeSkill, type EpisodeApi } from "./skill.js";
import { certUrlOk, timestampOk, verifyAlexaRequest } from "./verify.js";

type Play = {
  type: string;
  playBehavior?: string;
  audioItem: {
    stream: {
      url: string;
      token: string;
      offsetInMilliseconds: number;
      expectedPreviousToken?: string;
    };
  };
};

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe("alexa request verification", () => {
  it("accepts only the Amazon S3 echo.api certificate url shape", () => {
    expect(certUrlOk("https://s3.amazonaws.com/echo.api/echo-api-cert.pem")).toBe(true);
    expect(certUrlOk("https://s3.amazonaws.com:443/echo.api/x.pem")).toBe(true);
    expect(certUrlOk("http://s3.amazonaws.com/echo.api/x.pem")).toBe(false);
    expect(certUrlOk("https://notamazon.com/echo.api/x.pem")).toBe(false);
    expect(certUrlOk("https://s3.amazonaws.com/EcHo.aPi/x.pem")).toBe(false);
    expect(certUrlOk("https://s3.amazonaws.com:563/echo.api/x.pem")).toBe(false);
  });
  it("rejects a timestamp more than 150 s away", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    expect(timestampOk("2026-10-23T12:02:00Z", now)).toBe(true);
    expect(timestampOk("2026-10-23T12:03:00Z", now)).toBe(false);
    expect(timestampOk(undefined, now)).toBe(false);
  });
  it("refuses an unsigned request before any network call", async () => {
    await expect(
      verifyAlexaRequest(
        "{}",
        { certUrl: undefined, signature256: undefined },
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/certificate url/);
  });
});

function part(index: number, partId: string, ready: boolean): ManifestPart {
  const p: ManifestPart = {
    index,
    partId,
    heading: `h${index}`,
    summary: "",
    estSeconds: 30,
    origin: "plan",
    status: ready ? "ready" : "scripting",
  };
  if (ready) p.audio = { url: `/media/tok${index}`, seconds: 30 };
  return p;
}

function fakeApi(parts: ManifestPart[]): EpisodeApi {
  const manifest: Manifest = {
    id: "ep1",
    title: "T",
    dek: "",
    format: "explainer",
    status: "rendering",
    parts,
    targetSeconds: 180,
  };
  return {
    plan: () =>
      Promise.resolve({
        episodeId: "ep1",
        title: "T",
        dek: "",
        parts: [],
        totalEstSeconds: 180,
        speakable: "",
      }),
    render: () => Promise.resolve(),
    readManifest: () => Promise.resolve(manifest),
    expandPart: () => Promise.resolve(undefined),
    ask: () =>
      Promise.resolve({
        answer: "Because gold reflects infrared.",
        speaker: "expert",
        grounded: true,
        citations: [],
      }),
  };
}

const req = (request: Record<string, unknown>, token?: string) => ({
  context: {
    System: { user: { userId: "u" } },
    ...(token ? { AudioPlayer: { token, offsetInMilliseconds: 5000 } } : {}),
  },
  request: { timestamp: new Date().toISOString(), ...request },
});
const intent = (name: string, slots: Record<string, string> = {}) => ({
  type: "IntentRequest",
  intent: {
    name,
    slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { value: v }])),
  },
});

describe("overhear alexa skill", () => {
  it("plans, then plays the first part through the public media url", async () => {
    const skill = makeSkill({
      api: fakeApi([part(0, "p0", true), part(1, "p1", false)]),
      log: silent,
      publicBase: "https://t.example",
      pollMs: 1,
    });
    const planned = await skill.handle(req(intent("PlanIntent", { topic: "webb" })));
    expect(JSON.stringify(planned)).toContain("Say play");
    const played = await skill.handle(req(intent("PlayEpisodeIntent")));
    const d = (played.response.directives as Play[])[0];
    expect(d?.type).toBe("AudioPlayer.Play");
    expect(d?.audioItem.stream.url).toBe("https://t.example/media/tok0");
    expect(d?.audioItem.stream.token).toBe("ep1|p0");
  });

  it("answers a question from the ask tool and resumes where the listener was", async () => {
    const skill = makeSkill({
      api: fakeApi([part(0, "p0", true)]),
      log: silent,
      publicBase: "https://t.example",
      pollMs: 1,
    });
    const r = await skill.handle(req(intent("AskIntent", { question: "the mirror" }), "ep1|p0"));
    expect((r.response.outputSpeech as { text: string }).text).toContain("gold reflects infrared");
    const d = (r.response.directives as Play[])[0];
    expect(d?.audioItem.stream.offsetInMilliseconds).toBe(5000);
  });

  it("enqueues the next ready part when the current one nearly finishes", async () => {
    const skill = makeSkill({
      api: fakeApi([part(0, "p0", true), part(1, "p1", true)]),
      log: silent,
      publicBase: "https://t.example",
      pollMs: 1,
    });
    const r = await skill.handle(
      req({ type: "AudioPlayer.PlaybackNearlyFinished", token: "ep1|p0" }),
    );
    const d = (r.response.directives as Play[])[0];
    expect(d?.playBehavior).toBe("ENQUEUE");
    expect(d?.audioItem.stream.expectedPreviousToken).toBe("ep1|p0");
    expect(d?.audioItem.stream.token).toBe("ep1|p1");
    expect(r.response.outputSpeech).toBeUndefined();
  });
});
