// Public surface of the simulator host: the wire protocol types and the pure pieces that are unit
// tested. The runnable entry point is main.ts.

export * from "./protocol.js";
export { parseCommand } from "./commands.js";
export { classifyUtterance } from "./intent.js";
export { diffManifest } from "./manifest-diff.js";
export { computeTimeLeft } from "./timing.js";
export { proxyAudioUrl, mediaTokenOf } from "./media-proxy.js";
export { Session } from "./bridge.js";
export { OverhearClient, ToolError } from "./mcp-client.js";
