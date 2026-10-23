# Friction log: building Overhear for Alexa+

Overhear for Alexa+ is a two-host AI audio studio exposed as a Model Context Protocol
server. A listener gives it a topic, a URL or raw text and gets back a short two-voice
episode they can steer by voice: skip ahead, go deeper on a part, ask a question. We built
the server, a durable store layer behind it, a conformance harness and the device simulator
that stands in for Alexa+.

This log records the friction we hit, in the order it cost us time. Each entry carries the
task we attempted, the steps we took, what we expected against what happened, a severity,
the workaround we shipped and a suggestion we would send upstream.

Severity key: Blocker stops the build, High forces a redesign or a self-built replacement,
Medium costs real time or quality, Low is a papercut worth noting.

---

### 1. Alexa+ developer tooling is preview-only, so every entrant builds their own simulator

- Task attempted: Run our MCP server behind the real Alexa+ voice loop using the official
  developer tooling (the Category SDK, the MCP Toolkit, the CLI and the Web Simulator).
- Steps taken: Looked for entrant access to the preview developer tools, checked the console
  and the published docs for an enrollment path, then tried to find a way to point the tooling
  at a local MCP endpoint.
- Expected vs actual: We expected a simulator or a CLI that speaks the Alexa+ MCP client
  contract, so we could test against the surface a judge will drive. In practice the tooling
  is preview-only with no general entrant access, so there was nothing official to point the
  server at.
- Severity: High.
- Workaround: We stood up our own test surface. A conformance harness drives the server over
  raw HTTP, JSON-RPC and manual SSE with no SDK in the loop, so the real transport contract is
  exercised the way a device would hit it (`packages/conformance/src/cli.ts`). On top of that
  we are building our own device simulator, a browser UI with a gapless player, ducking and
  captions plus a host process that is the MCP client and tool bridge, because there is no
  official one to borrow.
- Actionable suggestion: Ship a minimal public simulator or a CLI that speaks the real MCP
  transport. Short of that, publish the exact client contract: the auth scheme, the required
  headers, the task-polling cadence and the tool call order. Without one, every entrant rebuilds
  the same harness and tests against a guess instead of the real client.

### 2. The SDK ships only in-memory stores and the example event store replays nothing

- Task attempted: Persist MCP tasks and Streamable HTTP events so a render survives a restart
  and so one listener never sees another listener's tasks.
- Steps taken: Wired the SDK InMemoryTaskStore and InMemoryTaskMessageQueue, then tried the
  example InMemoryEventStore for resumable SSE. Dropped the standalone GET stream mid-render
  and reconnected with the Last-Event-ID header.
- Expected vs actual: We expected the shipped stores to isolate by caller and survive a
  restart. The example event store should replay the events after the cursor. In practice all
  three in-memory stores lose state on restart. The task store and queue ignore the sessionId
  argument entirely, so there is no isolation between callers. The example InMemoryEventStore
  replayed zero events. It derives the stream id with `eventId.split("_")[0]`, but the
  transport names its standalone stream `_GET_stream`, so the split returns an empty string and
  `replayEventsAfter` bails before sending anything.
- Severity: High.
- Workaround: We wrote a durable store layer behind all three interfaces, a SQLite set for
  local runs and a DynamoDB set for cloud. The event store keeps the stream id in a column
  instead of parsing it out of the event id, so the standalone stream replays correctly. It
  also implements the optional `getStreamIdForEventId`. Every task method is partitioned by a
  resolved principal scope, so two callers are isolated even when the transport session id
  changes (`packages/durable-stores/src/sqlite/eventStore.ts`,
  `packages/durable-stores/src/sqlite/taskStore.ts`).
- Actionable suggestion: Mark the example event store as broken for the standalone stream.
  Failing that, fix the split so it handles a leading-underscore stream id. Ship at least one persistent
  reference store. Have the in-memory task store honour sessionId so isolation can be tested
  without a custom store.

### 3. registerToolTask is a handler trio and the SDK runs no background work

- Task attempted: Expose the long render as an MCP task tool a client can start and then poll.
- Steps taken: Called `server.experimental.tasks.registerToolTask(name, config, handler)` and
  read the handler type.
- Expected vs actual: We expected to hand the SDK one worker callback it would run in the
  background. The handler is a trio of `createTask`, `getTask` and `getTaskResult`. The SDK
  runs no work of its own. `createTask` has to create the task record, kick off the async work
  itself without awaiting it and return the CreateTaskResult immediately.
- Severity: Medium.
- Workaround: `createTask` persists a record to our durable task store, launches the render
  pipeline without awaiting it and returns status `working` with a capped ttl and a poll
  interval. `getTask` and `getTaskResult` read the store. The async worker drives status through
  the request-scoped store wrapper, so the SDK emits the status notifications for us.
- Actionable suggestion: State the three-method shape and the fire-and-forget contract at the
  top of the task docs, with a worked example that persists rather than one that is in-memory
  only. The current shape reads like a worker callback until you open the type.

### 4. getTaskResult throws without a resultSchema the type marks optional

- Task attempted: Fetch a finished task result from the client side.
- Steps taken: Called `client.experimental.tasks.getTaskResult(taskId)` with no result schema,
  because the type marks `resultSchema` optional.
- Expected vs actual: We expected it to return the stored result or a typed error. It threw
  `TypeError: Cannot read properties of undefined (reading '_zod')` from inside the SDK zod
  compatibility shim, because the implementation passes the schema to `safeParse`
  unconditionally even though the type says it is optional.
- Severity: Medium.
- Workaround: Always pass `CallToolResultSchema` as the result schema.
- Actionable suggestion: Make `resultSchema` required in the type. Failing that, default it
  internally so the type and the behavior agree.

### 5. Tool icons are not exposed by the high-level tool API

- Task attempted: Attach an icon to every tool so the simulator can show one per action.
- Steps taken: Looked for an `icons` field on the `registerTool` and `registerToolTask` config.
  Inspected a live `tools/list` entry for the `icons` key.
- Expected vs actual: The MCP protocol types carry `icons` on a tool (SEP-973), so we expected
  to pass them through the config. Neither `registerTool` nor `registerToolTask` accepts an
  `icons` field. The high-level `tools/list` serializer never emits one either, so a registered
  tool comes back with no icons at all.
- Severity: Medium.
- Workaround: We override the low-level `tools/list` handler on the underlying server and merge
  an icon descriptor per tool from a static map. The high-level registration stays, the icons
  are injected at serialization.
- Actionable suggestion: Accept `icons` on the tool config and serialize it, since the protocol
  already defines the field. Right now it exists in the schema but not in the high-level path.

### 6. A required-task tool called without a task returns an isError result embedding -32601

- Task attempted: Confirm what a required-task tool returns when a client calls it with no task
  augmentation.
- Steps taken: Sent a raw `tools/call` for a tool whose execution is `taskSupport: "required"`
  with no task field. Separately tried the same through the high-level client.
- Expected vs actual: We expected a JSON-RPC error with code `-32601`. The server instead
  returns a normal tool result with `isError: true` whose text embeds `-32601` as a string. The
  number is in the message, but the wire shape is a tool-error result, not a JSON-RPC error
  object. The high-level client is different again: it refuses before sending and throws
  `-32600`.
- Severity: Medium.
- Workaround: Our conformance check sends a raw `tools/call` and asserts the isError
  tool-result shape, not a JSON-RPC error, so it tests the server rather than the client guard.
- Actionable suggestion: Document that a required tool called without a task yields an isError
  result at the server and a thrown `-32600` at the client. The embedded `-32601` string reads
  like a protocol error and misleads a conformance test written against the number.

### 7. resources/subscribe is advertised but not handled by McpServer

- Task attempted: Push a resource update to the client when an episode manifest or a transcript
  changes, so the simulator refreshes without polling.
- Steps taken: Declared the resources subscribe capability and looked for the subscribe handler
  on McpServer.
- Expected vs actual: We expected McpServer to handle `resources/subscribe` once we advertised
  the capability. It advertises the capability and gives an outgoing `sendResourceUpdated`, but
  it registers no subscribe or unsubscribe handler, so a client subscribe would go unanswered.
- Severity: Medium.
- Workaround: We register `resources/subscribe` and `resources/unsubscribe` on the underlying
  low-level server, track the subscription set per session and call `sendResourceUpdated` on
  each manifest or part change.
- Actionable suggestion: Handle subscribe and unsubscribe in McpServer when the capability is
  declared. If that is out of scope, note in the docs that the capability is advertise-only and
  the handlers are the caller's job.

### 8. Polly generative voices have no emotion or speaking-style control

- Task attempted: Give the two hosts expressive delivery so surprise, irony and emphasis land in
  the dialogue.
- Steps taken: Drove Amazon Polly SynthesizeSpeech with the generative engine, mp3 output at
  24 kHz and a distinct voice id per format and speaker. Tried to vary delivery per line.
- Expected vs actual: We expected a speaking-style control, an emotion control or SSML prosody
  we could use for emphasis. The generative engine takes plain text with no emotion or style selection
  and honours only part of SSML, so a two-host script reads evenly and the comedic beats and the
  stressed words flatten out.
- Severity: Medium.
- Workaround: We write the emotion into the words. The script prompt tells the model to carry
  delivery through word choice and punctuation because the engine has no emotion control
  (`packages/core/src/prompts.ts:70`). We pick a different voice per format and speaker so
  the two hosts at least differ in timbre (`packages/server/src/config.ts:15-20`).
- Actionable suggestion: Expose a style or emotion parameter on the generative voices. Short of
  that, publish exactly which SSML tags they honour so a caller can place emphasis deliberately.

### 9. The web-standard transport enforces no Origin, Host or auth

- Task attempted: Refuse a cross-origin browser caller and an unauthenticated caller at the
  transport layer.
- Steps taken: Looked at the web-standard transport options for Origin, Host and DNS-rebinding
  controls. Sent a POST with a hostile Origin header.
- Expected vs actual: We expected the transport options to enforce an Origin allowlist. The
  options for `allowedHosts`, `allowedOrigins` and DNS-rebinding protection are all deprecated
  and off. A POST with `Origin: https://evil.example` returned 200. The transport enforces no
  Origin, no Host and no auth.
- Severity: Medium.
- Workaround: Our own middleware owns the checks before dispatch: an Origin allowlist to 403, a
  bearer token to 401 with a WWW-Authenticate header, a protocol-version check and an accept
  check. It binds to 127.0.0.1 unless a public bind is opted in.
- Actionable suggestion: Keep the deprecation note, but say plainly that Origin, Host and auth
  are entirely the embedder's responsibility now. A reader who trusts the option names ships an
  open server.

### 10. An unknown or terminated session id returns 400, not 404

- Task attempted: Return 404 for a request that carries an unknown or terminated session id, as
  the spec expects.
- Steps taken: Posted with a random session id, then posted again after deleting a session, both
  through a one-transport-per-session router.
- Expected vs actual: We expected the transport to answer 404 for an unknown or terminated
  session. In the per-session pattern the request reaches a freshly built transport that sees a
  non-initialize request and answers 400, not 404.
- Severity: Low.
- Workaround: Our session router looks the id up first and returns 404 itself for an unknown or
  terminated session, before any transport is constructed.
- Actionable suggestion: Document that 404 for unknown or terminated sessions is the router's job
  in the per-session pattern, since the transport only validates a session it already owns.

### 11. McpServer forces tools.listChanged true once any tool is registered

- Task attempted: Advertise `tools.listChanged: false`, because our tool list is fixed at boot.
- Steps taken: Declared capabilities with `tools.listChanged: false`, registered the tools and
  read back the advertised capabilities.
- Expected vs actual: We expected the declared false to hold. McpServer calls
  `registerCapabilities` with `tools.listChanged: true` the moment any tool is registered. The
  merge wins, so the server advertises true no matter what we declared.
- Severity: Low.
- Workaround: We accept true. A fixed list advertising listChanged true is harmless.
  Overriding it would mean dropping to the low-level capabilities path.
- Actionable suggestion: Let a declared `tools.listChanged: false` stand. If it cannot stand,
  note that registering any tool forces it true.

### 12. node:sqlite is experimental on Node 22 and prints an ExperimentalWarning

- Task attempted: Use node:sqlite for the local durable stores and the local episode store on
  Node 22.
- Steps taken: Imported `DatabaseSync` from `node:sqlite` and ran the suite on Node 22.
- Expected vs actual: We expected a stable built-in. node:sqlite is still experimental on Node 22
  and prints an ExperimentalWarning to stderr on first use.
- Severity: Low.
- Workaround: We leave the warning in place rather than silencing it with a flag, because hiding
  an experimental-API warning is worse than seeing it. The code uses only the stable surface
  (`DatabaseSync`, prepare, exec, WAL and a busy timeout).
- Actionable suggestion: None for the SDK. For other builders: expect the warning, do not
  suppress it globally and pin the Node version so the surface does not shift under you.

### 13. Wildcard subpath imports need the .js extension, named subpaths do not

- Task attempted: Import the SDK entry points under NodeNext module resolution.
- Steps taken: Imported both named subpaths and wildcard subpaths from the package.
- Expected vs actual: We expected one consistent rule. A named subpath (for example
  `experimental/tasks`) resolves with no extension, but a wildcard subpath (`server/mcp.js`,
  `client/streamableHttp.js`, `types.js`) throws `ERR_MODULE_NOT_FOUND` unless the `.js`
  extension is present.
- Severity: Low.
- Workaround: Add `.js` to every wildcard subpath import and leave the named ones bare. We keep
  them straight by matching the package examples.
- Actionable suggestion: Call out the split rule in the package docs. The error points at module
  resolution, not at the missing extension, so it costs a few minutes the first time.

### 14. Polly generative returns audio bytes but no clip duration

- Task attempted: Mix each spoken line against the music bed at the right offset, which needs
  each clip's true length.
- Steps taken: Called Polly generative SynthesizeSpeech and looked for a duration in the
  response.
- Expected vs actual: We expected a clip length or a speech-marks duration in the response. The
  generative call returns the mp3 byte stream with no duration, so mix timing has nothing to
  align against from the response alone.
- Severity: Low.
- Workaround: We write the returned bytes to a temp file and measure the real duration with
  ffprobe, then delete the file. A measured length beats a guess for mix timing
  (`packages/server/src/adapters/polly.ts:19-34`, `:91-99`).
- Actionable suggestion: Return a duration on the response. Short of that, document the
  speech-marks request as the supported way to get timing for generative output.

### 15. Resuming the standalone SSE stream too fast returns 409

- Task attempted: Reconnect the dropped standalone SSE stream with Last-Event-ID to replay the
  missed events.
- Steps taken: Dropped the GET stream mid-render, then immediately reopened it with the
  Last-Event-ID header.
- Expected vs actual: We expected the reopen to replay from the cursor. If the prior stream is
  still mapped, the reopen returns 409 Conflict, because only one standalone stream per session
  may be live. The SDK client backs off and retries on its own, but a hand-rolled reconnect races
  the teardown.
- Severity: Low.
- Workaround: A hand-rolled reconnect waits for the old stream to tear down before reopening. A
  short wait clears it in our test. In the product the client transport handles the backoff.
- Actionable suggestion: Note the single-standalone-stream rule and the 409 next to the
  resumability docs, so a custom client sequences the reconnect instead of hammering it.

### 16. Bedrock returns "Operation not allowed" for every model, with no hint of the cause

- Task attempted: Run the live demo with Amazon Nova writing the episode scripts through the
  Bedrock Converse API.
- Steps taken: Called `converse` from the CLI and from the server for Nova Lite, Nova Pro, Nova 2
  Lite, Llama 3 8B, Mistral 7B and gpt-oss-20b, in us-east-1, us-west-2 and us-east-2, with and
  without inference profiles. Then called `get-foundation-model-availability`.
- Expected vs actual: We expected a text reply, or an access error naming the missing step.
  Every call returned `ValidationException: Operation not allowed`. Only the availability call
  explained anything: `authorizationStatus: NOT_AUTHORIZED` while agreement, entitlement and
  region all read `AVAILABLE`. Amazon Polly on the same account worked first time.
- Severity: High. It blocked the live text path the day before the deadline.
- Workaround: An OpenAI-compatible text adapter behind the same `ModelAdapter` seam
  (`packages/server/src/adapters/openaiCompat.ts`), selected with `OVERHEAR_TEXT=openai`. Bedrock
  stays the default, and Polly still voices every line.
- Actionable suggestion: Return an `AccessDeniedException` that says the account is pending
  Bedrock verification and links to the support path, and show the same state on the console
  model-access page, instead of a validation error that reads like a malformed request.
