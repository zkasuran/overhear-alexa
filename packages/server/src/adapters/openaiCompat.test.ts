import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Logger } from "../contracts.js";
import { makeOpenAiCompatModel, readKeyFile } from "./openaiCompat.js";

const silent: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

function stubFetch(status: number, body: string, seen: { req?: RequestInit; url?: string }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    if (init) seen.req = init;
    return new Response(body, { status });
  }) as typeof fetch;
}

describe("openai-compatible text model", () => {
  it("sends system + user messages with the key as a bearer and returns the text", async () => {
    const seen: { req?: RequestInit; url?: string } = {};
    const m = makeOpenAiCompatModel(
      {
        baseUrl: "https://example.test/v1/",
        model: "m1",
        apiKey: "k-123",
        fetchImpl: stubFetch(
          200,
          JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
          seen,
        ),
      },
      silent,
    );
    const out = await m.generate({ system: "S", user: "U" }, { maxTokens: 50, temperature: 0.2 });
    expect(out).toBe("{}");
    expect(seen.url).toBe("https://example.test/v1/chat/completions");
    const headers = seen.req?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k-123");
    const body = JSON.parse(String(seen.req?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "m1", max_tokens: 50, temperature: 0.2 });
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
  });

  it("throws on a non-2xx status without echoing the key", async () => {
    const m = makeOpenAiCompatModel(
      {
        baseUrl: "https://x.test/v1",
        model: "m",
        apiKey: "secret-key",
        fetchImpl: stubFetch(401, "{}", {}),
      },
      silent,
    );
    await expect(m.generate({ system: "s", user: "u" })).rejects.toThrow(/HTTP 401/);
    await expect(m.generate({ system: "s", user: "u" })).rejects.not.toThrow(/secret-key/);
  });

  it("reads the first non-comment line of a key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovh-key-"));
    const f = join(dir, "key");
    writeFileSync(f, "# comment\n\n  abc  \nignored\n");
    expect(readKeyFile(f)).toBe("abc");
  });
});
