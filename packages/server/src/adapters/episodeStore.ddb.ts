// Per-principal episode persistence on DynamoDB, single table (config.tables.episodes), on-demand.
// Ownership is enforced on every read: the META item carries the owning principal and a read for a
// different principal returns null. Four item shapes share one table (see README.md):
//
//   PK                SK                      item
//   EP#{id}           META                    episode header (without parts), principal, ttl
//   EP#{id}           PART#{partId}           one part (incl. lines, audio ref, status)
//   EP#{id}           SRC                     normalised source text
//   PRIN#{principal}  EP#{createdAt}#{id}     per-principal index for listing and the daily quota
//
// Every item carries a numeric `ttl` (epoch seconds, now + RETENTION_DAYS) for DynamoDB TTL expiry.
// This adapter runs only under OVERHEAR_MODELS=aws + OVERHEAR_STORE=aws and is not exercised by the
// default test run.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { RETENTION_DAYS } from "@overhear/core";
import type { Episode, EpisodeManifest, Part, PartManifest } from "@overhear/core";
import type { Config, EpisodeStore, Logger } from "../contracts.js";

type Header = Omit<Episode, "parts">;
type PatchFields = Partial<Pick<Episode, "title" | "dek" | "status" | "parts" | "updatedAt">>;

const META = "META";
const SRC = "SRC";
const PART = "PART#";
const SEC_PER_DAY = 86_400;

const epPk = (id: string): string => `EP#${id}`;
const prinPk = (principal: string): string => `PRIN#${principal}`;
const prinSk = (createdAt: string, id: string): string => `EP#${createdAt}#${id}`;
const partSk = (partId: string): string => `${PART}${partId}`;

function ttlFrom(nowMs: number): number {
  return Math.floor(nowMs / 1000) + RETENTION_DAYS * SEC_PER_DAY;
}

function headerOf(ep: Episode): Header {
  const { parts: _parts, ...rest } = ep;
  return rest;
}

function toPartManifest(part: Part): PartManifest {
  const { lines: _lines, ...rest } = part;
  return rest;
}

function dropPrincipal(header: Header): Omit<Episode, "parts" | "principal"> {
  const { principal: _principal, ...rest } = header;
  return rest;
}

export function makeDdbEpisodeStore(config: Config, log: Logger): EpisodeStore {
  const table = config.tables.episodes;
  const base = new DynamoDBClient({ region: config.region });
  const doc = DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true },
  });
  log.info("dynamodb episode store ready", { table, region: config.region });

  // The owning META item for an episode or null when it does not exist or the principal is foreign.
  async function ownerMeta(principal: string, id: string): Promise<Record<string, unknown> | null> {
    const got = await doc.send(
      new GetCommand({ TableName: table, Key: { pk: epPk(id), sk: META } }),
    );
    const item = got.Item;
    if (!item) return null;
    if ((item.principal as unknown) !== principal) return null;
    return item;
  }

  async function readHeader(id: string): Promise<Header | null> {
    const got = await doc.send(
      new GetCommand({ TableName: table, Key: { pk: epPk(id), sk: META } }),
    );
    if (!got.Item) return null;
    return got.Item.episode as unknown as Header;
  }

  // All parts for an episode, ordered by playback index. Query returns them in SK order (partId), so
  // we sort by the part's own index after assembling. Pagination is handled for completeness.
  async function readParts(id: string): Promise<Part[]> {
    const parts: Part[] = [];
    let start: QueryCommandOutput["LastEvaluatedKey"];
    do {
      const out: QueryCommandOutput = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :pfx)",
          ExpressionAttributeValues: { ":pk": epPk(id), ":pfx": PART },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of out.Items ?? []) parts.push(item.part as unknown as Part);
      start = out.LastEvaluatedKey;
    } while (start);
    parts.sort((a, b) => a.index - b.index);
    return parts;
  }

  async function putPartItem(episodeId: string, part: Part, nowMs: number): Promise<void> {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { pk: epPk(episodeId), sk: partSk(part.partId), part, ttl: ttlFrom(nowMs) },
      }),
    );
  }

  return {
    // Not a single transaction: the META, SRC, PRIN index and part items are written in sequence.
    // Partial failure is handled by the caller's retry. All items share one 7-day ttl.
    async createEpisode(ep: Episode, sourceText: string): Promise<void> {
      const now = Date.now();
      const ttl = ttlFrom(now);
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: epPk(ep.id),
            sk: META,
            principal: ep.principal,
            createdAt: ep.createdAt,
            episode: headerOf(ep),
            ttl,
          },
        }),
      );
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { pk: epPk(ep.id), sk: SRC, text: sourceText, ttl },
        }),
      );
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: prinPk(ep.principal),
            sk: prinSk(ep.createdAt, ep.id),
            episodeId: ep.id,
            createdAt: ep.createdAt,
            ttl,
          },
        }),
      );
      for (const part of ep.parts) await putPartItem(ep.id, part, now);
    },

    async getEpisode(principal: string, episodeId: string): Promise<Episode | null> {
      const meta = await ownerMeta(principal, episodeId);
      if (!meta) return null;
      const header = meta.episode as unknown as Header;
      return { ...header, parts: await readParts(episodeId) };
    },

    async getSource(principal: string, episodeId: string): Promise<string | null> {
      const meta = await ownerMeta(principal, episodeId);
      if (!meta) return null;
      const got = await doc.send(
        new GetCommand({ TableName: table, Key: { pk: epPk(episodeId), sk: SRC } }),
      );
      if (!got.Item) return null;
      return got.Item.text as unknown as string;
    },

    async putPart(principal: string, episodeId: string, part: Part): Promise<void> {
      const meta = await ownerMeta(principal, episodeId);
      if (!meta) return;
      await putPartItem(episodeId, part, Date.now());
    },

    async patchEpisode(principal: string, episodeId: string, patch: PatchFields): Promise<void> {
      const meta = await ownerMeta(principal, episodeId);
      if (!meta) return;
      const now = Date.now();
      const header = meta.episode as unknown as Header;
      const next: Header = {
        ...header,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.dek !== undefined ? { dek: patch.dek } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: epPk(episodeId),
            sk: META,
            principal: next.principal,
            createdAt: next.createdAt,
            episode: next,
            ttl: ttlFrom(now),
          },
        }),
      );
      if (patch.parts !== undefined) {
        for (const old of await readParts(episodeId)) {
          await doc.send(
            new DeleteCommand({
              TableName: table,
              Key: { pk: epPk(episodeId), sk: partSk(old.partId) },
            }),
          );
        }
        for (const part of patch.parts) await putPartItem(episodeId, part, now);
      }
    },

    async listByPrincipal(principal: string, limit: number): Promise<EpisodeManifest[]> {
      const out: QueryCommandOutput = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": prinPk(principal) },
          ScanIndexForward: false, // SK sorts by createdAt, so descending gives newest first
          Limit: limit,
        }),
      );
      const manifests: EpisodeManifest[] = [];
      for (const item of out.Items ?? []) {
        const id = item.episodeId as unknown as string;
        const header = await readHeader(id);
        if (!header) continue;
        manifests.push({
          ...dropPrincipal(header),
          parts: (await readParts(id)).map(toPartManifest),
        });
      }
      return manifests;
    },

    async countEpisodesSince(principal: string, sinceIso: string): Promise<number> {
      let total = 0;
      let start: QueryCommandOutput["LastEvaluatedKey"];
      do {
        const out: QueryCommandOutput = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk AND sk >= :sk",
            ExpressionAttributeValues: { ":pk": prinPk(principal), ":sk": `EP#${sinceIso}` },
            Select: "COUNT",
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
        total += out.Count ?? 0;
        start = out.LastEvaluatedKey;
      } while (start);
      return total;
    },

    async close(): Promise<void> {
      base.destroy();
    },
  };
}
