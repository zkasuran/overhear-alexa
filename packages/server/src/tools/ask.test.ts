// ask: citation substring mapping and the grounded / ungrounded paths.

import { describe, it, expect } from "vitest";
import { mapCitations, runAsk } from "./ask.js";
import type { TranscriptLine } from "./ask.js";
import type { Services } from "../contracts.js";
import type { Episode, Line, Part } from "@overhear/core";

const LINES: TranscriptLine[] = [
  { partId: "pt_0", lineId: "ln_a", text: "The Fed cut rates by a quarter point." },
  { partId: "pt_0", lineId: "ln_b", text: "Two members dissented and wanted a hold." },
];

describe("mapCitations", () => {
  it("maps a verbatim quote to its line and drops an unmatched quote", () => {
    const out = mapCitations(LINES, ["a quarter point", "this is not in the transcript"]);
    expect(out).toEqual([{ partId: "pt_0", lineId: "ln_a", quote: "a quarter point" }]);
  });

  it("never invents a citation when nothing matches", () => {
    expect(mapCitations(LINES, ["entirely made up"])).toEqual([]);
    expect(mapCitations([], ["anything"])).toEqual([]);
  });
});

function fakeServices(modelJson: string): Services {
  return {
    config: { voices: { explainer: { host: "H", expert: "E" } } },
    episodes: {
      async getSource() {
        return "The Fed cut rates. Two members dissented.";
      },
    },
    model: {
      id: "fake",
      async generate() {
        return modelJson;
      },
    },
    tts: {
      async synthesize() {
        return { audio: new Uint8Array(64), seconds: 3.2, mime: "audio/mpeg" as const };
      },
    },
    storage: {
      async putAudio(episodeId: string, partId: string) {
        return `key/${episodeId}/${partId}`;
      },
      async urlFor(key: string) {
        return `https://media.test/${key}`;
      },
    },
  } as unknown as Services;
}

function episodeWithLines(): Episode {
  const lines: Line[] = [
    { lineId: "ln_a", speaker: "host", text: "The Fed cut rates by a quarter point." },
    { lineId: "ln_b", speaker: "expert", text: "Two members dissented and wanted a hold." },
  ];
  const p: Part = {
    index: 0,
    partId: "pt_0",
    heading: "Cold open",
    summary: "The decision.",
    estSeconds: 30,
    origin: "plan",
    status: "ready",
    lines,
  };
  return {
    id: "ep_1",
    principal: "user-1",
    title: "The cut",
    dek: "A test.",
    format: "explainer",
    targetSeconds: 120,
    status: "ready",
    parts: [p],
    sourceKind: "topic",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("runAsk", () => {
  it("grounds the answer, maps the citation and attaches audio", async () => {
    const services = fakeServices(
      JSON.stringify({
        answer: "Two members dissented.",
        grounded: true,
        citations: [{ quote: "Two members dissented" }],
      }),
    );
    const result = await runAsk(services, episodeWithLines(), { question: "who dissented?" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.grounded).toBe(true);
    expect(result.structuredContent?.speaker).toBe("expert");
    expect(result.structuredContent?.citations).toEqual([
      { partId: "pt_0", lineId: "ln_b", quote: "Two members dissented" },
    ]);
    const audio = result.structuredContent?.audio as { url: string; seconds: number } | undefined;
    expect(audio?.url).toContain("https://media.test/");
    expect(audio?.seconds).toBeGreaterThan(0);
  });

  it("drops to ungrounded when every quote is fabricated", async () => {
    const services = fakeServices(
      JSON.stringify({
        answer: "Something.",
        grounded: true,
        citations: [{ quote: "a line that is nowhere in the transcript" }],
      }),
    );
    const result = await runAsk(services, episodeWithLines(), { question: "q" });
    expect(result.structuredContent?.grounded).toBe(false);
    expect(result.structuredContent?.citations).toEqual([]);
  });

  it("keeps grounded=false and empty citations when the model cannot answer", async () => {
    const services = fakeServices(
      JSON.stringify({ answer: "The episode did not cover that.", grounded: false, citations: [] }),
    );
    const result = await runAsk(services, episodeWithLines(), { question: "q" });
    expect(result.structuredContent?.grounded).toBe(false);
    expect(result.structuredContent?.citations).toEqual([]);
  });
});
