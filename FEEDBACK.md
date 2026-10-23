# API feedback: Overhear for Alexa+

One block per interface we built against. Each says what we used it for, what worked, what
needs work, how onboarding felt and whether we would build on it again.

Where we had no AWS credentials this session, the AWS calls were not exercised live. We say so
in the block rather than invent a latency or quality number. Those paths are written against
the AWS SDK for JavaScript v3 and covered by deterministic mock twins and unit tests, so the
default run needs no keys and spends nothing.

---

## MCP 2025-11-25 spec and the TypeScript SDK (with experimental tasks)

- Used for: The whole server contract. The web-standard Streamable HTTP transport on Hono,
  tools, resources, prompts and the experimental task surface behind render and expand.
  Exercised live in a single Node process that initializes, creates a task, polls it, drops and
  resumes the SSE stream and fetches the result.
- What worked well: The web-standard transport mounts in one line, takes a WHATWG Request and
  returns a Response, so it drops straight onto Hono. Protocol negotiation settled on 2025-11-25
  as expected. Once a task store is supplied the SDK serves `tasks/get`, `tasks/result`,
  `tasks/list` and `tasks/cancel` itself, long-polls `tasks/result` to terminal and emits the
  status notifications on the standalone stream. The transport-level HTTP behavior is correct
  out of the box: 406 without the event-stream accept, 400 for a missing session or a bad
  protocol version, 202 for a bare notification, 405 for an unsupported method and a 413 body
  cap. Resumability over Last-Event-ID works once a correct event store is in place.
- What needs work: The experimental task surface has sharp edges. The handler is a three-method
  trio and runs no background work. `getTaskResult` throws without a result schema the type says
  is optional. Tool icons are defined in the protocol but not plumbed through the high-level API.
  A required tool called without a task returns an isError result embedding `-32601` rather than
  a protocol error. `resources/subscribe` is advertise-only. The only shipped stores are
  in-memory. The one example event store does not replay the standalone stream.
  `tools.listChanged` is forced true once any tool registers. The friction log covers each.
- Onboarding: The examples are current and use zod v4, which matched the installed tree. The
  import rule splits between named subpaths (no extension) and wildcard subpaths (needing
  `.js`), which costs a first-time reader a few minutes. The task docstrings are decent but the
  fire-and-forget contract is easy to miss.
- Build again? Yes. The transport and the server-served task methods carried most of the weight.
  The gaps were all in the preview task surface and the demo stores, which we expected to fill
  ourselves.

## Amazon Bedrock (Converse)

- Used for: The two text models that plan an episode and write each part of the script, Nova
  Lite and Nova Pro by default, selectable by env.
- What worked well: The Converse shape is clean and provider-neutral. A system block plus a user
  message, `maxTokens` and `temperature` in `inferenceConfig`. The reply is an array of content
  blocks we join. One AbortController folds our timeout and the caller's signal into the single
  signal the SDK aborts on, so a slow model cannot hang a render
  (`packages/server/src/adapters/bedrock.ts:38-56`).
- What needs work: On our account every Converse call, for every model and region we tried
  (Nova Lite, Nova Pro, Nova 2 Lite, Llama, Mistral; us-east-1, us-west-2, us-east-2), returns
  `ValidationException: Operation not allowed`, and `get-foundation-model-availability` reports
  `authorizationStatus: NOT_AUTHORIZED`. The error names neither the cause (account verification)
  nor the fix, so it cost real time. We kept Bedrock as the default text provider and added an
  OpenAI-compatible adapter behind the same seam so the live demo could run. The specific foundation model's own usage terms have to be accepted
  before a live run, which the service terms do not cover on their own. Converse returning text
  as an array of blocks means a caller has to join them rather than read one string.
- Onboarding: The v3 client is a region plus a model id and one command. Straightforward.
- Build again? Yes. The provider-neutral request shape is the right abstraction for swapping
  models by env.

## Amazon Nova 2 Sonic

- Used for: The real-time two-way voice session in the simulator host, the piece that turns
  spoken listener input into tool calls and speaks the result back.
- What worked well: Not exercised live. We did not have a path to run a live Sonic session this
  session, so we built the fallback first and kept the Sonic session behind a clean seam in the
  host. We make no claim about its latency or quality because we have not run it.
- What needs work: Honestly, the gap is access and a clear contract. The bidirectional streaming
  shape is involved and preview, so without a running session and sample traffic a builder is
  coding to a description. We shipped a push-to-talk fallback so the simulator works end to end
  without it.
- Onboarding: We cannot rate it fairly without having run a session. The published material
  describes the model but we had no way to exercise it here.
- Build again? Planned, once we can run a live session. The host already isolates it so it drops
  in behind the fallback.

## Amazon Polly (generative)

- Used for: Text to speech for the two host voices, one mp3 clip per line, with a distinct
  generative voice per format and speaker.
- What worked well: Exercised live in us-west-2. SynthesizeSpeech with the generative engine, mp3
  at 24 kHz and a voice id, worked first time for Ruth, Matthew, Danielle, Stephen and Joanna.
  A full live session voiced and mixed its first part about 21 s after connect, script writing
  included. Our mock twin stands in for the default run and emits a real short mp3 tone sized
  to the text, so the product is audible without any AWS call and a judge hears something real
  (`packages/server/src/adapters/mock/tts.ts`).
- What needs work: Not every voice has the generative engine (Gregory and Kevin return
  `This voice does not support the selected engine`), and the voice list does not make that easy
  to see up front, so our default cozy voice failed until we swapped it. The generative engine has no emotion or speaking-style control and honours
  only part of SSML, so a scripted two-host dialogue loses surprise and irony. We moved the
  delivery into the words and the punctuation to compensate. The response also carries no clip
  duration, so we measure the real bytes with ffprobe to time the mix.
- Onboarding: Engine and voice selection are clear. Which SSML tags the generative voices honour
  is not documented well, so emphasis is trial and error.
- Build again? Yes, for the voice quality. We would still carry delivery in the script until a
  style control exists.

## Amazon S3

- Used for: Storing each rendered mp3 in cloud mode and handing back a short-lived presigned URL
  the device plays.
- What worked well: Not exercised live this session. The path is two v3 calls, a PutObject with
  server-side encryption and a presigned GET from the request-presigner, with a capped URL
  lifetime. Nothing surprising in the shape (`packages/server/src/adapters/storage.ts:102-126`).
- What needs work: We cannot report live behavior without credentials. The local twin writes an
  mp3 under an unguessable token and serves it at `/media/{token}`, so the two modes stay behind
  one interface.
- Onboarding: Standard v3. The presigner is a separate small package, which is easy to miss on
  the first read.
- Build again? Yes.

## Amazon DynamoDB

- Used for: The episode store, the task store and the event store in cloud mode.
- What worked well: Not exercised live this session (live-gated tests only, no credentials). The
  single-table design fits well: the partition key is the resolved principal scope and the sort
  key is the id, so one Query reads exactly one caller's rows. Conditional writes enforce the
  task lifecycle, a rejected condition maps to an illegal-transition error and a TTL attribute
  drives cleanup. The DocumentClient keeps the item shapes plain
  (`packages/durable-stores/src/dynamo/taskStore.ts`).
- What needs work: No live numbers without credentials. LastEvaluatedKey pagination needs an
  opaque cursor we encode ourselves, since handing the raw key to a client would leak the table
  shape.
- Onboarding: Standard v3 with lib-dynamodb. The conditional-write idioms for a state machine
  took a careful read of the docs.
- Build again? Yes. Conditional writes plus a TTL attribute cover the task lifecycle without a
  second system.

## Kiro

- Used for: Building the project. Navigating an npm-workspace monorepo, writing the adapters, the
  stores and their tests, then running the gate (type-check, tests, lint, format) on each change.
- What worked well: It held the strict TypeScript conventions across packages: ESM with `.js` on
  relative imports, type-only imports under `verbatimModuleSyntax`, no `any` and the guard rules
  for indexed access. Multi-file edits across the workspace stayed consistent, so the frozen
  contract files kept their shape while the adapters grew.
- What needs work: It is strongest when the conventions are written down for it to follow. On the
  preview SDK, where behavior disagreed with the types, it needed the measured facts in front of
  it rather than the type signatures, the same as a human would.
- Onboarding: Low friction inside the repo. The gate commands are the contract. Running them
  after each change caught drift early.
- Build again? Yes.

## Alexa+ developer resources

- Used for: Running the voice experience on the official Alexa+ tooling: the Category SDK, the
  MCP Toolkit, the CLI and the Web Simulator.
- What worked well: Not exercised, the tooling is preview-only with no entrant access. The
  direction is clear and right: Alexa+ as an MCP client driving third-party servers over a public
  transport. Because the MCP contract itself is public, we could build the server to the spec and
  test it against our own harness and our own simulator.
- What needs work: With the tooling gated, we built our own conformance harness and our own
  device simulator to stand in for it. A public statement of the exact Alexa+ client
  behavior would remove the guesswork: the auth scheme, the required headers, the task-polling
  cadence, the tool call order and how it holds the SSE stream open.
- Onboarding: The vision is documented, the tools are not reachable. That gap is the single
  biggest piece of friction in the program for a build like this.
- Build again? Yes. More directly once the tooling opens. The server is already built to the
  published contract.
