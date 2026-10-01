// Resource surface: the per-episode manifest, transcript and source, plus the static formats catalogue.
// The manifest is the playback source of truth (an episode without per-line detail); it and the
// transcript are subscribable, so a client is told the moment a part changes status. Reads are owner
// scoped: a principal that does not own an episode gets "not found", never another principal's data and
// never a "forbidden" that would confirm the id exists (see SECURITY.md). resources/subscribe and
// resources/unsubscribe are registered on the low-level server because the high-level API does not carry
// them; the handlers track the subscribed URIs per connection and sendResourceUpdated fires on change.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Icon, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { Episode, EpisodeManifest } from "@overhear/core";
import { FORMATS, FORMAT_IDS } from "@overhear/core";
import type { Logger, Services } from "./contracts.js";
import type { Extra } from "./tools/common.js";
import { orderedParts, principalOf } from "./tools/common.js";

const SCHEME = "overhear://";

// JSON-RPC error code for a resource that does not exist (MCP resources error, distinct from -32602).
const RESOURCE_NOT_FOUND = -32002;
export const FORMATS_URI = `${SCHEME}formats`;

export function manifestUri(episodeId: string): string {
  return `${SCHEME}episodes/${episodeId}/manifest`;
}
export function transcriptUri(episodeId: string): string {
  return `${SCHEME}episodes/${episodeId}/transcript`;
}
export function sourceUri(episodeId: string): string {
  return `${SCHEME}episodes/${episodeId}/source`;
}

/** The manifest view of an episode: no owner, no per-line detail. */
export function toManifest(episode: Episode): EpisodeManifest {
  const { principal: _principal, parts, ...rest } = episode;
  return { ...rest, parts: parts.map(({ lines: _lines, ...part }) => part) };
}

/** Speaker-labelled transcript of the ready parts, each line tagged with its stable id for citations. */
export function transcriptMarkdown(episode: Episode): string {
  const blocks: string[] = [];
  for (const part of orderedParts(episode)) {
    if (part.status !== "ready" || part.lines === undefined) continue;
    const lines = part.lines.map((l) => `**${l.speaker}** (${l.lineId}): ${l.text}`);
    blocks.push(`## ${part.heading}\n\n${lines.join("\n")}`);
  }
  return blocks.length > 0
    ? `# ${episode.title}\n\n${blocks.join("\n\n")}\n`
    : `# ${episode.title}\n`;
}

/** The four formats, their two voices and musical mood. Static, provider neutral, no owner data. */
export function formatsCatalogue(): { formats: ReadonlyArray<Record<string, string>> } {
  return {
    formats: FORMAT_IDS.map((id) => {
      const f = FORMATS[id];
      return {
        id: f.id,
        label: f.label,
        blurb: f.blurb,
        host: f.hostName,
        expert: f.expertName,
        mood: f.bedMood,
      };
    }),
  };
}

const SOURCE_RE = new RegExp(`^${SCHEME}episodes/([^/]+)/(manifest|transcript|source)$`);

/** Parse a per-episode resource URI into its episode id and kind, or null when it is not one of ours. */
export function parseEpisodeUri(
  uri: string,
): { episodeId: string; kind: "manifest" | "transcript" | "source" } | null {
  const m = SOURCE_RE.exec(uri);
  if (m === null) return null;
  const episodeId = m[1];
  const kind = m[2];
  if (episodeId === undefined || kind === undefined) return null;
  if (kind !== "manifest" && kind !== "transcript" && kind !== "source") return null;
  return { episodeId, kind };
}

function iconMeta(icons: ReadonlyMap<string, Icon[]>, name: string): { icons: Icon[] } | undefined {
  const ic = icons.get(name);
  return ic ? { icons: ic } : undefined;
}

function notFound(): never {
  // "not found" (never "forbidden") so a non-owner cannot confirm an episode id exists.
  // Resource not found uses the resources error code -32002, not -32602.
  throw new McpError(RESOURCE_NOT_FOUND, "Resource not found");
}

/** Tracks the resource URIs a single connection has subscribed to. */
export class ResourceSubscriptions {
  readonly #uris = new Set<string>();
  add(uri: string): void {
    this.#uris.add(uri);
  }
  remove(uri: string): void {
    this.#uris.delete(uri);
  }
  has(uri: string): boolean {
    return this.#uris.has(uri);
  }
}

type EpisodeResourceKind = "manifest" | "transcript" | "source";

function readOne(
  services: Services,
  kind: EpisodeResourceKind,
): (
  uri: URL,
  variables: Record<string, string | string[]>,
  extra: Extra,
) => Promise<ReadResourceResult> {
  return async (uri, variables, extra) => {
    const principal = principalOf(extra);
    if (principal === undefined) notFound();
    const raw = variables.id;
    const episodeId = Array.isArray(raw) ? raw[0] : raw;
    if (episodeId === undefined) notFound();
    const episode = await services.episodes.getEpisode(principal, episodeId);
    if (episode === null) notFound();
    if (kind === "manifest") {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(toManifest(episode)),
          },
        ],
      };
    }
    if (kind === "transcript") {
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: transcriptMarkdown(episode) }],
      };
    }
    const source = await services.episodes.getSource(principal, episodeId);
    if (source === null) notFound();
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: source }] };
  };
}

/**
 * Register the four resources and the subscribe/unsubscribe handlers. The three per-episode resources
 * are URI templates (read owner scoped); the formats catalogue is static. subscribe/unsubscribe live on
 * the low-level server because the high-level API does not carry them.
 */
export function registerResources(
  server: McpServer,
  services: Services,
  subs: ResourceSubscriptions,
  icons: ReadonlyMap<string, Icon[]>,
  log: Logger,
): void {
  server.registerResource(
    "formats",
    FORMATS_URI,
    {
      title: "Show formats",
      description: "The four show formats, their two voices and musical mood.",
      mimeType: "application/json",
      ...(iconMeta(icons, "formats") ?? {}),
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "application/json", text: JSON.stringify(formatsCatalogue()) },
      ],
    }),
  );

  const templates: ReadonlyArray<{
    name: string;
    kind: EpisodeResourceKind;
    uri: string;
    icon: string;
    title: string;
    description: string;
  }> = [
    {
      name: "episode-manifest",
      kind: "manifest",
      uri: manifestUri("{id}"),
      icon: "manifest",
      title: "Episode manifest",
      description:
        "The playback source of truth: the episode and its parts without per-line detail.",
    },
    {
      name: "episode-transcript",
      kind: "transcript",
      uri: transcriptUri("{id}"),
      icon: "transcript",
      title: "Episode transcript",
      description:
        "Speaker-labelled transcript of the ready parts, each line tagged for citations.",
    },
    {
      name: "episode-source",
      kind: "source",
      uri: sourceUri("{id}"),
      icon: "source",
      title: "Episode source",
      description: "The normalised source text the episode was built from.",
    },
  ];

  for (const t of templates) {
    server.registerResource(
      t.name,
      new ResourceTemplate(t.uri, { list: undefined }),
      { title: t.title, description: t.description, ...(iconMeta(icons, t.icon) ?? {}) },
      readOne(services, t.kind),
    );
  }

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subs.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subs.remove(request.params.uri);
    return {};
  });

  log.info("resources registered", { count: templates.length + 1 });
}

/** Notify subscribers that an episode's manifest and transcript changed. No-op for unsubscribed URIs. */
export async function touchEpisodeResources(
  server: McpServer,
  subs: ResourceSubscriptions,
  episodeId: string,
  log: Logger,
): Promise<void> {
  for (const uri of [manifestUri(episodeId), transcriptUri(episodeId)]) {
    if (!subs.has(uri)) continue;
    try {
      await server.server.sendResourceUpdated({ uri });
    } catch {
      log.warn("resource update notification failed", { uri });
    }
  }
}
