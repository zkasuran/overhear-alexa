import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTokenFile,
  makeAuthVerifier,
  parseTokenTable,
  tokenFileModeIsSecure,
  verifyBearer,
} from "./auth.js";

function sha256Hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("parseTokenTable", () => {
  it("parses principal:sha256 lines and skips blanks and comments", () => {
    const text = [
      "# a comment",
      "",
      `alice:${sha256Hex("alpha")}`,
      `  bob:${sha256Hex("bravo")}  `,
    ].join("\n");
    const table = parseTokenTable(text);
    expect(table.map((e) => e.principal)).toEqual(["alice", "bob"]);
    expect(table[0]?.digest.length).toBe(32);
  });

  it("drops malformed lines (no colon, empty principal, bad digest)", () => {
    const text = [
      "no-colon-here",
      `:${sha256Hex("x")}`,
      "carol:not-a-sha",
      `dave:${sha256Hex("delta")}`,
    ].join("\n");
    const table = parseTokenTable(text);
    expect(table.map((e) => e.principal)).toEqual(["dave"]);
  });
});

describe("tokenFileModeIsSecure", () => {
  it("accepts 600 or stricter and rejects any group or world access", () => {
    expect(tokenFileModeIsSecure(0o600)).toBe(true);
    expect(tokenFileModeIsSecure(0o400)).toBe(true);
    expect(tokenFileModeIsSecure(0o640)).toBe(false);
    expect(tokenFileModeIsSecure(0o604)).toBe(false);
    expect(tokenFileModeIsSecure(0o644)).toBe(false);
  });
});

describe("verifyBearer", () => {
  const table = parseTokenTable(
    [`alice:${sha256Hex("alpha")}`, `bob:${sha256Hex("bravo")}`].join("\n"),
  );

  it("returns the owning principal for a valid token", () => {
    expect(verifyBearer(table, "Bearer alpha")).toBe("alice");
    expect(verifyBearer(table, "Bearer bravo")).toBe("bob");
  });

  it("is case-insensitive on the scheme and tolerant of extra spacing", () => {
    expect(verifyBearer(table, "bearer alpha")).toBe("alice");
    expect(verifyBearer(table, "Bearer   alpha")).toBe("alice");
  });

  it("rejects a wrong token, a missing header and a wrong scheme", () => {
    expect(verifyBearer(table, "Bearer wrong")).toBeNull();
    expect(verifyBearer(table, null)).toBeNull();
    expect(verifyBearer(table, undefined)).toBeNull();
    expect(verifyBearer(table, "Basic alpha")).toBeNull();
    expect(verifyBearer(table, "Bearer ")).toBeNull();
  });

  it("exposes the same behaviour through makeAuthVerifier", () => {
    const verifier = makeAuthVerifier(table);
    expect(verifier.verifyBearer("Bearer alpha")).toBe("alice");
    expect(verifier.verifyBearer("Bearer nope")).toBeNull();
  });
});

describe("loadTokenFile", () => {
  function writeToken(mode: number): string {
    const dir = mkdtempSync(join(tmpdir(), "overhear-auth-"));
    const file = join(dir, "tokens");
    writeFileSync(file, `alice:${sha256Hex("alpha")}\n`);
    chmodSync(file, mode);
    return file;
  }

  it("loads a 600 token file", () => {
    const file = writeToken(0o600);
    const table = loadTokenFile(file);
    expect(table[0]?.principal).toBe("alice");
  });

  it("rejects a group or world readable file without the dev allowance", () => {
    const file = writeToken(0o644);
    expect(() => loadTokenFile(file)).toThrow(/group or world/);
  });

  it("permits a group or world readable file with the dev allowance", () => {
    const file = writeToken(0o644);
    const table = loadTokenFile(file, { allowInsecurePermissions: true });
    expect(table[0]?.principal).toBe("alice");
  });

  it("throws on a missing file", () => {
    expect(() => loadTokenFile(join(tmpdir(), "overhear-missing-token-file"))).toThrow();
  });

  it("throws when no valid entries are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "overhear-auth-"));
    const file = join(dir, "tokens");
    writeFileSync(file, "# only a comment\n");
    chmodSync(file, 0o600);
    expect(() => loadTokenFile(file)).toThrow(/no valid/);
  });
});
