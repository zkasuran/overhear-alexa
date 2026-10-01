// Helpers shared by the tool handlers. A tool returns a CallToolResult: `content` is the model-facing
// text and `structuredContent` is the machine payload. Input and ceiling violations are reported as a
// tool execution error (isError:true) with a sentence safe to read aloud, never a protocol error, so a
// voice client can speak the problem. The owning principal comes from the validated bearer token; a
// request with no principal is treated as unauthenticated here as a floor, since the HTTP layer rejects
// unauthenticated requests before dispatch (see SECURITY.md).

import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Episode, Part } from "@overhear/core";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The owner of a request: the validated bearer token's principal, or undefined when unauthenticated. */
export function principalOf(extra: Extra): string | undefined {
  return extra.authInfo?.clientId;
}

/** A model-facing text block. */
export function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** A tool execution error with a spoken sentence. Never a protocol error (SEP-1303). */
export function toolError(message: string): CallToolResult {
  return { content: [textBlock(message)], isError: true };
}

/** A successful tool result: a structured payload plus a sentence the producer can read. */
export function okResult(
  structuredContent: Record<string, unknown>,
  spoken: string,
): CallToolResult {
  return { structuredContent, content: [textBlock(spoken)] };
}

/** A short spoken sentence for an unexpected failure. Keeps internals out of the spoken channel. */
export function speakableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 0 ? message : "Something went wrong while building that.";
}

/** The audible length of a part in seconds: the mixed audio when ready, else the planned estimate. */
export function partSeconds(part: Part): number {
  return part.audio ? part.audio.seconds : part.estSeconds;
}

/** An episode's parts in playback order (ids are identity, index is position). */
export function orderedParts(episode: Episode): Part[] {
  return [...episode.parts].sort((a, b) => a.index - b.index);
}
