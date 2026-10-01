// Acceptance test for the deterministic text-model mock. For every prompt builder in @overhear/core
// we feed the mock's reply through extractJson and the matching schema, so a drift between the mock
// and the frozen output shapes fails here rather than in the render pipeline. We also pin determinism
// (same prompt in, same bytes out) and the bounded render-ahead delay.

import { describe, it, expect } from "vitest";
import {
  planPrompt,
  scriptPartPrompt,
  expandPrompt,
  askPrompt,
  recapPrompt,
  findMomentPrompt,
  extractJson,
  newPartId,
} from "@overhear/core";
import {
  PlanModelOutput,
  ScriptModelOutput,
  ExpandModelOutput,
  AskModelOutput,
  RecapModelOutput,
  FindModelOutput,
} from "../../schemas.js";
import { makeMockModel, MOCK_DELAY_MIN_MS, MOCK_DELAY_MAX_MS } from "./model.js";

const SOURCE =
  "Octopuses have three hearts and blue, copper-based blood. Two hearts pump blood to the gills, " +
  "while the third drives it to the rest of the body. They are strikingly intelligent for invertebrates.";
const TRANSCRIPT = "Ava: Octopuses have three hearts.\nTheo: Two of them feed the gills.";

const plan = planPrompt({ sourceText: SOURCE, format: "explainer", minutes: 6, focus: "biology" });
const script = scriptPartPrompt({
  sourceText: SOURCE,
  episodeTitle: "Octopus Minds",
  format: "explainer",
  heading: "Three hearts",
  summary: "How octopus circulation actually works",
  estSeconds: 60,
  priorTranscript: "",
});
const expand = expandPrompt({
  sourceText: SOURCE,
  format: "explainer",
  parentHeading: "Three hearts",
  angle: "why the blood is blue",
  transcriptSoFar: "Ava: Octopuses are strange.\nTheo: Wonderfully strange.",
});
const ask = askPrompt({ sourceText: SOURCE, transcript: TRANSCRIPT, question: "How many hearts?" });
const recap = recapPrompt({ transcriptUpTo: TRANSCRIPT, seconds: 30 });
const outline = [
  { partId: newPartId(), heading: "Cold open", summary: "a quick hook" },
  { partId: newPartId(), heading: "Three hearts", summary: "circulation" },
  { partId: newPartId(), heading: "Smart suckers", summary: "octopus cognition" },
];
const find = findMomentPrompt({ outline, query: "how smart are octopuses" });

const model = makeMockModel();

describe("mock model output passes the matching schema", () => {
  it("plan prompt => PlanModelOutput", async () => {
    const out = PlanModelOutput.parse(extractJson(await model.generate(plan)));
    expect(out.parts.length).toBeGreaterThanOrEqual(1);
    expect(out.parts[0]?.estSeconds).toBe(30);
  });

  it("script prompt => ScriptModelOutput", async () => {
    const out = ScriptModelOutput.parse(extractJson(await model.generate(script)));
    expect(out.lines.length).toBeGreaterThanOrEqual(1);
    expect(out.lines[0]?.speaker).toBe("host");
  });

  it("expand prompt => ExpandModelOutput", async () => {
    const out = ExpandModelOutput.parse(extractJson(await model.generate(expand)));
    expect(out.heading.length).toBeGreaterThan(0);
  });

  it("ask prompt => AskModelOutput, grounded with a citation from the transcript", async () => {
    const out = AskModelOutput.parse(extractJson(await model.generate(ask)));
    expect(out.grounded).toBe(true);
    expect(out.citations.length).toBeGreaterThanOrEqual(1);
    const quote = out.citations[0]?.quote ?? "";
    expect(TRANSCRIPT.replace(/\s+/g, " ")).toContain(quote);
  });

  it("recap prompt => RecapModelOutput", async () => {
    const out = RecapModelOutput.parse(extractJson(await model.generate(recap)));
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("find prompt => FindModelOutput, partId is one of the outline ids", async () => {
    const out = FindModelOutput.parse(extractJson(await model.generate(find)));
    expect(outline.map((p) => p.partId)).toContain(out.partId);
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });
});

describe("determinism and timing", () => {
  it("same prompt in, same bytes out", async () => {
    for (const p of [plan, script, expand, ask, recap, find]) {
      const a = await model.generate(p);
      const b = await model.generate(p);
      expect(a).toBe(b);
    }
  });

  it("the delay is bounded", async () => {
    const t0 = Date.now();
    await model.generate(recap);
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(MOCK_DELAY_MIN_MS - 25);
    expect(dt).toBeLessThanOrEqual(MOCK_DELAY_MAX_MS + 1000);
  });

  it("rejects an unrecognised prompt shape", async () => {
    await expect(
      model.generate({ system: "x", user: "no json instruction here" }),
    ).rejects.toThrow();
  });
});
