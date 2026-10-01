// Audio storage, both run modes behind one factory (StorageAdapter in ../contracts.ts).
// LOCAL writes an mp3 per part under a random, unguessable token and serves it at /media/{token};
// the key->token map is persisted so urlFor survives a restart. AWS puts to S3 (SSE-S3) and presigns.
// Local tokens are per-part random, not derivable from the key (see SECURITY.md).

import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MEDIA_TOKEN_BYTES, newMediaToken, randomBase62 } from "@overhear/core";
import type { Config, Logger, StorageAdapter } from "../contracts.js";

const INDEX_FILE = "_index.json";
const TOKEN_RE = /^[0-9A-Za-z]+$/; // base62, matches @overhear/core ids alphabet

// A server-issued media token is MEDIA_TOKEN_BYTES of entropy rendered in base62 (~22 chars). Cap the
// accepted :token length at twice that so a hostile path param stays bounded (ceiling on untrusted input).
const MEDIA_TOKEN_CHARS = Math.ceil((MEDIA_TOKEN_BYTES * 8) / Math.log2(62));
const MAX_MEDIA_TOKEN_CHARS = MEDIA_TOKEN_CHARS * 2;

/** Map a /media/:token path param to an absolute file. Returns null for a bad token (traversal, non-base62). */
export function resolveMediaToken(token: string, mediaDir: string): string | null {
  if (token.length === 0 || token.length > MAX_MEDIA_TOKEN_CHARS || !TOKEN_RE.test(token))
    return null;
  const dir = resolve(mediaDir);
  const file = resolve(dir, `${token}.mp3`);
  const rel = relative(dir, file);
  // base62 has no separators so file is always directly under dir; this is defence in depth.
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return file;
}

type Index = Record<string, string>; // key (`${episodeId}/${partId}`) -> media token

function loadIndex(indexPath: string, log: Logger): Index {
  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch {
    return {}; // first run, no index yet
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("media index is not valid JSON, starting empty", { indexPath });
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("media index is not an object, starting empty", { indexPath });
    return {};
  }
  const out: Index = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function writeIndexAtomic(indexPath: string, index: Index): Promise<void> {
  const tmp = join(dirname(indexPath), `${INDEX_FILE}.${process.pid}.${randomBase62(8)}.tmp`);
  await writeFile(tmp, JSON.stringify(index), "utf8");
  await rename(tmp, indexPath); // atomic within the same directory
}

function makeLocalStorage(config: Config, log: Logger): StorageAdapter {
  const mediaDir = config.mediaDir;
  const indexPath = join(mediaDir, INDEX_FILE);
  mkdirSync(mediaDir, { recursive: true });
  const index = loadIndex(indexPath, log);
  log.info("storage: local media", { mediaDir, entries: Object.keys(index).length });

  // Serialise index persists so every on-disk snapshot includes all prior entries.
  let pending: Promise<void> = Promise.resolve();
  function persistIndex(): Promise<void> {
    const next = pending.then(() => writeIndexAtomic(indexPath, index));
    pending = next.catch(() => undefined);
    return next;
  }

  return {
    async putAudio(episodeId: string, partId: string, bytes: Uint8Array): Promise<string> {
      const token = newMediaToken(MEDIA_TOKEN_BYTES);
      await writeFile(join(mediaDir, `${token}.mp3`), bytes);
      const key = `${episodeId}/${partId}`;
      index[key] = token;
      await persistIndex();
      return key;
    },
    async urlFor(key: string): Promise<string> {
      const token = index[key];
      if (token === undefined) {
        log.error("urlFor: no media stored for key", { key });
        throw new Error(`urlFor: unknown media key ${key}`);
      }
      return `/media/${token}`;
    },
  };
}

function makeAwsStorage(config: Config, log: Logger): StorageAdapter {
  const client = new S3Client({ region: config.region });
  log.info("storage: aws s3", { bucket: config.s3Bucket, region: config.region });

  return {
    async putAudio(episodeId: string, partId: string, bytes: Uint8Array): Promise<string> {
      const key = `ep/${episodeId}/${partId}.mp3`;
      await client.send(
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: key,
          Body: bytes,
          ContentType: "audio/mpeg",
          ServerSideEncryption: "AES256",
        }),
      );
      return key;
    },
    async urlFor(key: string): Promise<string> {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }), {
        expiresIn: config.presignTtlSeconds,
      });
    },
  };
}

/** Build the storage adapter for the configured run mode. */
export function makeStorage(config: Config, log: Logger): StorageAdapter {
  return config.storeMode === "aws" ? makeAwsStorage(config, log) : makeLocalStorage(config, log);
}
