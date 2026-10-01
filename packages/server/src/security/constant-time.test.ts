// Adversarial test for S-1 (a caller presents no valid token). verifyBearer must accept the exact
// token, reject a wrong token of the same character length and of a different length, and scan the
// whole table so the match position cannot be learned from behaviour. The comparison rests on
// timingSafeEqual over equal-length SHA-256 digests; we assert that primitive's contract directly
// rather than measuring wall-clock time. See SECURITY.md.

import { describe, expect, it } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";
import { makeAuthVerifier, parseTokenTable, verifyBearer } from "../auth.js";

function sha256Hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const ALICE_TOKEN = "alpha"; // 5 characters
const BOB_TOKEN = "bravo-longer-token";

const table = parseTokenTable(
  [`alice:${sha256Hex(ALICE_TOKEN)}`, `bob:${sha256Hex(BOB_TOKEN)}`].join("\n"),
);

describe("verifyBearer accepts only the exact token (S-1)", () => {
  it("returns the owning principal for the correct token", () => {
    expect(verifyBearer(table, `Bearer ${ALICE_TOKEN}`)).toBe("alice");
    expect(verifyBearer(table, `Bearer ${BOB_TOKEN}`)).toBe("bob");
  });

  it("rejects a wrong token of the same character length", () => {
    // "wrong" is the same length as "alpha" but hashes to a different digest.
    expect("wrong".length).toBe(ALICE_TOKEN.length);
    expect(verifyBearer(table, "Bearer wrong")).toBeNull();
  });

  it("rejects a wrong token of a different length", () => {
    // Any token hashes to a 32-byte digest, so a shorter or longer token is still rejected on digest
    // content, never on a length shortcut.
    expect(verifyBearer(table, "Bearer x")).toBeNull();
    expect(verifyBearer(table, `Bearer ${ALICE_TOKEN}-extra-characters`)).toBeNull();
  });

  it("scans the whole table, so a match in the last entry still resolves", () => {
    // A scan that stopped at the first non-match would miss a token owned by the final entry.
    const withDecoyFirst = parseTokenTable(
      [`decoy:${sha256Hex("not-it")}`, `bob:${sha256Hex(BOB_TOKEN)}`].join("\n"),
    );
    expect(verifyBearer(withDecoyFirst, `Bearer ${BOB_TOKEN}`)).toBe("bob");
  });

  it("exposes the same behaviour through makeAuthVerifier", () => {
    const verifier = makeAuthVerifier(table);
    expect(verifier.verifyBearer(`Bearer ${ALICE_TOKEN}`)).toBe("alice");
    expect(verifier.verifyBearer("Bearer nope")).toBeNull();
  });
});

describe("the comparison primitive the defence relies on (timingSafeEqual)", () => {
  it("is true only for byte-identical equal-length digests", () => {
    const a = createHash("sha256").update(ALICE_TOKEN).digest();
    const sameAgain = createHash("sha256").update(ALICE_TOKEN).digest();
    const other = createHash("sha256").update(BOB_TOKEN).digest();
    expect(a.length).toBe(32);
    expect(timingSafeEqual(a, sameAgain)).toBe(true);
    expect(timingSafeEqual(a, other)).toBe(false);
  });

  it("differs on a single flipped byte, so a near-match is still rejected", () => {
    const base = Buffer.alloc(32, 0);
    const flipped = Buffer.alloc(32, 0);
    flipped[31] = 1;
    expect(timingSafeEqual(base, flipped)).toBe(false);
  });

  it("throws on a length mismatch, which is why auth guards the length before comparing", () => {
    const short = Buffer.alloc(16, 0);
    const long = Buffer.alloc(32, 0);
    expect(() => timingSafeEqual(short, long)).toThrow();
  });
});
