// Pure diff of two manifest snapshots. The bridge polls the manifest while an episode renders and feeds
// each snapshot through here to decide what changed since the last poll: which parts moved status (so
// the outline chips update) and which parts just became playable (so their audio is handed to the
// browser exactly once). Kept pure so it is unit-tested without a server.

import type { ManifestPart } from "./mcp-client.js";

export type Diff = {
  statusChanged: ManifestPart[];
  newlyReady: ManifestPart[];
  newParts: ManifestPart[];
};

/**
 * Compare the current parts against what was seen before. `lastStatus` maps partId to its last status
 * and `readyEmitted` is the set of parts already handed over as playable. Neither is mutated here; the
 * caller updates them after acting on the diff.
 */
export function diffManifest(
  lastStatus: ReadonlyMap<string, string>,
  readyEmitted: ReadonlySet<string>,
  parts: readonly ManifestPart[],
): Diff {
  const statusChanged: ManifestPart[] = [];
  const newlyReady: ManifestPart[] = [];
  const newParts: ManifestPart[] = [];
  for (const part of parts) {
    const before = lastStatus.get(part.partId);
    if (before === undefined) newParts.push(part);
    if (before !== part.status) statusChanged.push(part);
    if (part.status === "ready" && part.audio !== undefined && !readyEmitted.has(part.partId)) {
      newlyReady.push(part);
    }
  }
  return { statusChanged, newlyReady, newParts };
}
