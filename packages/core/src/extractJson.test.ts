import { test, expect } from "vitest";
import fc from "fast-check";
import { extractJson } from "./extractJson.js";

test("extractJson: plain object", () => {
  expect(extractJson('{"a":1}')).toEqual({ a: 1 });
});

test("extractJson: fenced json block", () => {
  expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
});

test("extractJson: ignores trailing prose after the object (the real model bug)", () => {
  const raw = '{"title":"x","segments":[]}\n\nHope that helps!';
  expect(extractJson(raw)).toEqual({ title: "x", segments: [] });
});

test("extractJson: tolerates braces and quotes inside strings", () => {
  const raw = 'noise {"text":"a } and a \\" quote","n":1} tail';
  expect(extractJson(raw)).toEqual({ text: 'a } and a " quote', n: 1 });
});

test("extractJson: throws when there is no object", () => {
  expect(() => extractJson("no json here")).toThrow(Error);
});

test("extractJson: throws on incomplete object", () => {
  expect(() => extractJson('{"a":1')).toThrow(Error);
});

test("extractJson: rejects pathologically deep nesting", () => {
  const deep = "{".repeat(200) + "}".repeat(200);
  expect(() => extractJson(deep)).toThrow(/too deep/i);
});

// Property: on ANY string input, extractJson either returns a value or throws an Error.
// It must never throw a non-Error, hang, or leak a raw SyntaxError.
test("extractJson: total over random bytes (never throws non-Error)", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      try {
        extractJson(s);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }),
    { numRuns: 2000 },
  );
});

// Property: extracting from text that embeds a valid JSON object recovers it.
test("extractJson: recovers an embedded object regardless of surrounding noise", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "grapheme" }),
      fc.string({ unit: "grapheme" }),
      fc.record({ k: fc.integer(), v: fc.boolean() }),
      (pre, post, obj) => {
        // Keep the prefix free of braces so the first "{" is the object's, and strip
        // backticks from both sides so a stray fence cannot change which body is scanned.
        const clean = pre.replace(/[{}`]/g, "");
        const tail = post.replace(/[`]/g, "");
        const raw = `${clean}${JSON.stringify(obj)}${tail}`;
        expect(extractJson(raw)).toEqual(obj);
      },
    ),
    { numRuns: 1000 },
  );
});
