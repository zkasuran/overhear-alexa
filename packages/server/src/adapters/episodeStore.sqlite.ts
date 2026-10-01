// Per-principal episode persistence on node:sqlite, the local twin of the DynamoDB store.
// Ownership is enforced on every read: a principal that does not own an episode gets null, never
// another principal's rows. Episodes, their source text and their parts live in three tables. The
// episode header is stored without its parts so the parts table stays the one source of truth.
//
// node:sqlite prints an ExperimentalWarning on this Node version. That is expected, so we do not
// suppress it with a flag.

import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Episode, EpisodeManifest, Part, PartManifest } from "@overhear/core";
import type { EpisodeStore, Logger } from "../contracts.js";

type Header = Omit<Episode, "parts">;
type PatchFields = Partial<Pick<Episode, "title" | "dek" | "status" | "parts" | "updatedAt">>;

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function readText(v: SQLOutputValue | undefined): string {
  if (typeof v !== "string") throw new Error("sqlite: expected a text column");
  return v;
}

function readInt(v: SQLOutputValue | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error("sqlite: expected an integer column");
}

function headerOf(ep: Episode): Header {
  const { parts: _parts, ...rest } = ep;
  return rest;
}

function toPartManifest(part: Part): PartManifest {
  const { lines: _lines, ...rest } = part;
  return rest;
}

function toManifest(header: Header, parts: Part[]): EpisodeManifest {
  const { principal: _principal, ...rest } = header;
  return { ...rest, parts: parts.map(toPartManifest) };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  json       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source (
  episode_id TEXT PRIMARY KEY,
  text       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
  episode_id TEXT NOT NULL,
  part_id    TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  json       TEXT NOT NULL,
  PRIMARY KEY (episode_id, part_id)
);
CREATE INDEX IF NOT EXISTS idx_episodes_principal ON episodes (principal, created_at);
CREATE INDEX IF NOT EXISTS idx_parts_episode ON parts (episode_id, idx);
`;

export function makeSqliteEpisodeStore(dbPath: string, log: Logger): EpisodeStore {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  log.info("sqlite episode store opened", { path: dbPath });

  const insEpisode = db.prepare(
    "INSERT INTO episodes (id, principal, created_at, json) VALUES (?, ?, ?, ?)",
  );
  const insSource = db.prepare("INSERT INTO source (episode_id, text) VALUES (?, ?)");
  const upsertPart = db.prepare(
    "INSERT INTO parts (episode_id, part_id, idx, json) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(episode_id, part_id) DO UPDATE SET idx = excluded.idx, json = excluded.json",
  );
  const selHeader = db.prepare("SELECT json FROM episodes WHERE id = ? AND principal = ?");
  const selParts = db.prepare(
    "SELECT json FROM parts WHERE episode_id = ? ORDER BY idx ASC, part_id ASC",
  );
  const selSource = db.prepare(
    "SELECT s.text AS text FROM source s JOIN episodes e ON e.id = s.episode_id WHERE s.episode_id = ? AND e.principal = ?",
  );
  const selOwns = db.prepare("SELECT 1 AS one FROM episodes WHERE id = ? AND principal = ?");
  const updHeader = db.prepare("UPDATE episodes SET json = ? WHERE id = ? AND principal = ?");
  const delParts = db.prepare("DELETE FROM parts WHERE episode_id = ?");
  const selList = db.prepare(
    "SELECT json FROM episodes WHERE principal = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  );
  const selCount = db.prepare(
    "SELECT COUNT(*) AS n FROM episodes WHERE principal = ? AND created_at >= ?",
  );

  function tx(fn: () => void): void {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function readParts(episodeId: string): Part[] {
    return selParts.all(episodeId).map((row) => parseJson<Part>(readText(row.json)));
  }

  return {
    async createEpisode(ep: Episode, sourceText: string): Promise<void> {
      tx(() => {
        insEpisode.run(ep.id, ep.principal, ep.createdAt, JSON.stringify(headerOf(ep)));
        insSource.run(ep.id, sourceText);
        for (const part of ep.parts) {
          upsertPart.run(ep.id, part.partId, part.index, JSON.stringify(part));
        }
      });
    },

    async getEpisode(principal: string, episodeId: string): Promise<Episode | null> {
      const row = selHeader.get(episodeId, principal);
      if (!row) return null;
      const header = parseJson<Header>(readText(row.json));
      return { ...header, parts: readParts(episodeId) };
    },

    async getSource(principal: string, episodeId: string): Promise<string | null> {
      const row = selSource.get(episodeId, principal);
      return row ? readText(row.text) : null;
    },

    async putPart(principal: string, episodeId: string, part: Part): Promise<void> {
      if (!selOwns.get(episodeId, principal)) return;
      upsertPart.run(episodeId, part.partId, part.index, JSON.stringify(part));
    },

    async patchEpisode(principal: string, episodeId: string, patch: PatchFields): Promise<void> {
      const row = selHeader.get(episodeId, principal);
      if (!row) return;
      const header = parseJson<Header>(readText(row.json));
      const next: Header = {
        ...header,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.dek !== undefined ? { dek: patch.dek } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      };
      tx(() => {
        updHeader.run(JSON.stringify(next), episodeId, principal);
        if (patch.parts !== undefined) {
          delParts.run(episodeId);
          for (const part of patch.parts) {
            upsertPart.run(episodeId, part.partId, part.index, JSON.stringify(part));
          }
        }
      });
    },

    async listByPrincipal(principal: string, limit: number): Promise<EpisodeManifest[]> {
      return selList.all(principal, limit).map((row) => {
        const header = parseJson<Header>(readText(row.json));
        return toManifest(header, readParts(header.id));
      });
    },

    async countEpisodesSince(principal: string, sinceIso: string): Promise<number> {
      const row = selCount.get(principal, sinceIso);
      return row ? readInt(row.n) : 0;
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
