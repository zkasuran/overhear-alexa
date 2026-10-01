// Adversarial test for S-9 (a log reader lifts a token). The structured logger must redact
// authorization and token-shaped fields at the sink, in both the stable base context and the
// per-call fields, so a secret passed by mistake never reaches a log line. We capture
// process.stderr.write, parse the emitted JSON and assert the sensitive values are gone and the
// plaintext never appears anywhere in the line. See SECURITY.md.

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLogger } from "../log.js";

const REDACTED = "[redacted]";

/** Capture every line the logger writes to stderr without letting it reach the real stderr. */
function captureStderr(): () => string[] {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () =>
    spy.mock.calls.map((call) => {
      const chunk = call[0];
      return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    });
}

/** The first emitted line, as a string. Fails the test if the logger wrote nothing. */
function firstLine(lines: string[]): string {
  expect(lines.length).toBeGreaterThan(0);
  return lines[0] ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeLogger redaction (S-9)", () => {
  it("redacts token-shaped fields passed per call and keeps the rest", () => {
    const lines = captureStderr();
    makeLogger().info("request", {
      authorization: "Bearer super-secret-token",
      token: "another-secret",
      bearer: "yet-another-secret",
      cookie: "session=abc",
      "set-cookie": "session=def",
      principal: "alice",
    });

    const line = firstLine(lines());
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.authorization).toBe(REDACTED);
    expect(parsed.token).toBe(REDACTED);
    expect(parsed.bearer).toBe(REDACTED);
    expect(parsed.cookie).toBe(REDACTED);
    expect(parsed["set-cookie"]).toBe(REDACTED);
    // Redaction is selective, not a blanket wipe: a safe field survives.
    expect(parsed.principal).toBe("alice");
    // No plaintext secret reaches the sink in any form.
    expect(line).not.toContain("super-secret-token");
    expect(line).not.toContain("another-secret");
    expect(line).not.toContain("yet-another-secret");
  });

  it("redacts token-shaped fields carried in the base context", () => {
    const lines = captureStderr();
    makeLogger({ authorization: "Bearer base-secret", models: "mock" }).info("boot");

    const line = firstLine(lines());
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.authorization).toBe(REDACTED);
    expect(parsed.models).toBe("mock");
    expect(line).not.toContain("base-secret");
  });

  it("redacts regardless of field-name case", () => {
    const lines = captureStderr();
    makeLogger().warn("mixed-case", { Authorization: "Bearer X", Token: "Y", Cookie: "Z" });

    const parsed = JSON.parse(firstLine(lines())) as Record<string, unknown>;
    expect(parsed.Authorization).toBe(REDACTED);
    expect(parsed.Token).toBe(REDACTED);
    expect(parsed.Cookie).toBe(REDACTED);
  });

  it("carries redaction through a child logger's base", () => {
    const lines = captureStderr();
    makeLogger()
      .child({ token: "child-secret", principal: "bob" })
      .info("child-event", { cookie: "c=1" });

    const line = firstLine(lines());
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.token).toBe(REDACTED);
    expect(parsed.cookie).toBe(REDACTED);
    expect(parsed.principal).toBe("bob");
    expect(line).not.toContain("child-secret");
  });
});
