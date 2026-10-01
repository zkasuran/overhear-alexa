import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEDIA_TOKEN_BYTES } from "@overhear/core";
import { loadConfig } from "../config.js";
import type { Config, Logger } from "../contracts.js";
import { makeStorage, resolveMediaToken } from "./storage.js";

const MIN_TOKEN_CHARS = Math.ceil((MEDIA_TOKEN_BYTES * 8) / Math.log2(62));

function makeLog(): Logger {
  const log: Logger = {
    info() {},
    warn() {},
    error() {},
    child: () => log,
  };
  return log;
}

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "overhear-storage-"));
  dirs.push(d);
  return d;
}
function localConfig(mediaDir: string): Config {
  return { ...loadConfig({}), storeMode: "local", mediaDir };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("local: put, serve, resolve round-trip; token is unguessable and not the key", async () => {
  const dir = freshDir();
  const storage = makeStorage(localConfig(dir), makeLog());
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x01, 0x02, 0x03]); // "ID3" + payload

  const key = await storage.putAudio("ep_abc", "pt_123", bytes);
  expect(key).toBe("ep_abc/pt_123");

  const url = await storage.urlFor(key);
  expect(url).toMatch(/^\/media\/[0-9A-Za-z]+$/);

  const token = url.slice("/media/".length);
  expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_CHARS); // carries the full entropy
  expect(token).not.toBe(key); // the served token is not the opaque key
  expect(url).not.toContain("ep_abc"); // url is not derivable from the key
  expect(url).not.toContain("pt_123");

  const resolved = resolveMediaToken(token, dir);
  expect(resolved).not.toBeNull();
  const roundtrip = readFileSync(resolved as string);
  expect(new Uint8Array(roundtrip)).toEqual(bytes); // bytes survive the write + read
});

test("local: resolveMediaToken rejects traversal and non-base62, accepts a clean token", () => {
  const dir = freshDir();
  expect(resolveMediaToken("../x", dir)).toBeNull();
  expect(resolveMediaToken("../../etc/passwd", dir)).toBeNull();
  expect(resolveMediaToken("a/b", dir)).toBeNull();
  expect(resolveMediaToken("a.b", dir)).toBeNull();
  expect(resolveMediaToken("", dir)).toBeNull();
  expect(resolveMediaToken("x".repeat(MIN_TOKEN_CHARS * 10), dir)).toBeNull(); // over the length ceiling

  expect(resolveMediaToken("abc123XYZ", dir)).toBe(join(dir, "abc123XYZ.mp3"));
});

test("local: the index survives a fresh makeStorage (restart)", async () => {
  const dir = freshDir();
  const first = makeStorage(localConfig(dir), makeLog());
  const key = await first.putAudio("ep_r", "pt_r", new Uint8Array([1, 2, 3]));
  const urlBefore = await first.urlFor(key);
  expect(existsSync(join(dir, "_index.json"))).toBe(true);

  // A brand new adapter over the same dir models a process restart.
  const second = makeStorage(localConfig(dir), makeLog());
  const urlAfter = await second.urlFor(key);
  expect(urlAfter).toBe(urlBefore); // same token, read back from the persisted index
});

// AWS needs real keys + a bucket, so it only runs under OVERHEAR_LIVE_TESTS=1 (default gate never spends).
const liveAws = process.env.OVERHEAR_LIVE_TESTS === "1";
test.skipIf(!liveAws)("aws: put to S3 then presign a GET url (live)", async () => {
  const cfg = loadConfig({ ...process.env, OVERHEAR_MODELS: "aws", OVERHEAR_STORE: "aws" });
  const storage = makeStorage(cfg, makeLog());
  const key = await storage.putAudio("ep_live", "pt_live", new Uint8Array([0x49, 0x44, 0x33]));
  expect(key).toBe("ep/ep_live/pt_live.mp3");
  const url = await storage.urlFor(key);
  expect(url).toMatch(/^https:\/\//);
});
