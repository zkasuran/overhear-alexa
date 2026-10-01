# AWS usage

Overhear turns a web page or a pasted article into a short two-voice audio episode. Its default run mode is fully local: `OVERHEAR_MODELS=mock` with `OVERHEAR_STORE=local` uses deterministic in-process stand-ins for every cloud call, writes audio to the local disk and needs no AWS account, no credentials and no spend. That is the mode the test suite and the offline demo run in.

AWS is reached only when a run flips two switches, both read in `packages/server/src/config.ts`:

- `OVERHEAR_MODELS=aws` routes text generation to Amazon Bedrock and speech to Amazon Polly (config.ts:35).
- `OVERHEAR_STORE=aws` routes persistence to Amazon S3 and Amazon DynamoDB (config.ts:36).

The two are coupled: an AWS store with mock models is refused at boot, because it would write fixtures into DynamoDB (config.ts:39). The rest of this page is drawn from the adapter code, with a `file:line` on every call so a reader can check it.

## Services and the exact calls

| Service                    | What it does here                                         | SDK command                                                                  | Source                                                       |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Amazon Bedrock (Runtime)   | plan and script generation, one Converse request per call | `ConverseCommand` on `BedrockRuntimeClient`                                  | bedrock.ts:9, bedrock.ts:22, bedrock.ts:56                   |
| Amazon Polly               | one line of script to one mp3 clip, generative engine     | `SynthesizeSpeechCommand` on `PollyClient`                                   | polly.ts:11, polly.ts:38, polly.ts:62                        |
| Amazon S3                  | store each part mp3, hand back a presigned GET            | `PutObjectCommand`, `GetObjectCommand` with `getSignedUrl`                   | storage.ts:9, storage.ts:103, storage.ts:109, storage.ts:121 |
| Amazon DynamoDB (episodes) | per-principal episode persistence, single table           | `PutCommand`, `GetCommand`, `QueryCommand`, `DeleteCommand`                  | episodeStore.ddb.ts:15, episodeStore.ddb.ts:62               |
| Amazon DynamoDB (tasks)    | durable async task records plus their message queue       | `PutCommand`, `GetCommand`, `QueryCommand`, `UpdateCommand`, `DeleteCommand` | taskStore.ts:105, messageQueue.ts:81, main.ts:52             |
| Amazon DynamoDB (events)   | resumable MCP event log for stream replay                 | `TransactWriteCommand`, `GetCommand`, `QueryCommand`, `UpdateCommand`        | eventStore.ts:70, eventStore.ts:50, main.ts:51               |

All clients are built with only a `region` (bedrock.ts:22, polly.ts:38, storage.ts:103, episodeStore.ddb.ts:62, common.ts:48). The region comes from `AWS_REGION` or `OVERHEAR_REGION`, defaulting to `us-east-1` (config.ts:52). Credentials are resolved by the default AWS SDK provider chain, so this server never reads a key from its own config or argv.

### Bedrock

`makeBedrockModel(modelId, region)` builds one `BedrockRuntimeClient` and sends a `ConverseCommand` per generation (bedrock.ts:21, bedrock.ts:56). The system string becomes one system block. The user string becomes one user message. `maxTokens` and `temperature` go in `inferenceConfig` (bedrock.ts:28, bedrock.ts:31). The model id is chosen by config, not hard-coded: `OVERHEAR_PLAN_MODEL` defaults to `amazon.nova-lite-v1:0` and `OVERHEAR_SCRIPT_MODEL` defaults to `amazon.nova-pro-v1:0` (config.ts:54). The assembled services bind the script model for every text call today (index.ts:27), so a minimal deployment needs only the script model enabled, but the policy below lists both configured ids.

### Polly

`makePollyTts(region)` sends a `SynthesizeSpeechCommand` with `Engine: "generative"`, `OutputFormat: "mp3"` and `SampleRate: "24000"` (polly.ts:62). The voice id per format and speaker comes from config, defaulting to a set of generative voice names overridable with `OVERHEAR_VOICE_*` env vars (config.ts:15, config.ts:22). The real byte length of each clip is measured with ffprobe for mix timing (polly.ts:19), so Polly is the only paid call on the speech path.

### S3

In AWS store mode `makeAwsStorage` builds one `S3Client` and, per part, sends a `PutObjectCommand` to the key `ep/{episodeId}/{partId}.mp3` with `ContentType: "audio/mpeg"` and `ServerSideEncryption: "AES256"` (storage.ts:102, storage.ts:108, storage.ts:110, storage.ts:115). Playback never serves bytes through the server: `urlFor` returns a presigned GET built with `getSignedUrl` over a `GetObjectCommand`, expiring after `config.presignTtlSeconds` (storage.ts:121). That value is `PRESIGN_TTL_SECONDS`, 15 minutes (ceilings.ts:62).

### DynamoDB

Three tables, all reached through the DynamoDB Document client with `removeUndefinedValues` on (episodeStore.ddb.ts:63, common.ts:48). None of the stores ever create a table (common.ts:18), so the tables and their TTL settings are provisioned out of band before the server starts.

## DynamoDB table design

The default table names are `overhear`, `overhear-tasks` and `overhear-events`, each overridable by env (config.ts:59). Every table uses a string partition key `pk` and a string sort key `sk`. On-demand capacity fits the bursty per-episode write pattern.

### Episodes table (default `overhear`)

One table holds four item shapes, keyed so a single partition is one episode and a second partition is one principal's index (episodeStore.ddb.ts:1, episodeStore.ddb.ts:36):

| `pk`               | `sk`                  | item                                                                             |
| ------------------ | --------------------- | -------------------------------------------------------------------------------- |
| `EP#{id}`          | `META`                | episode header, owning `principal`, `createdAt`, `ttl` (episodeStore.ddb.ts:123) |
| `EP#{id}`          | `PART#{partId}`       | one part with its lines, audio ref and status (episodeStore.ddb.ts:108)          |
| `EP#{id}`          | `SRC`                 | normalised source text (episodeStore.ddb.ts:136)                                 |
| `PRIN#{principal}` | `EP#{createdAt}#{id}` | per-principal index for listing and the daily quota (episodeStore.ddb.ts:142)    |

Reads are a `GetCommand` on the META key or a `QueryCommand` with `begins_with(sk, "PART#")` for parts (episodeStore.ddb.ts:70, episodeStore.ddb.ts:93). Listing and the daily quota query the `PRIN#` partition (episodeStore.ddb.ts:219, episodeStore.ddb.ts:245). Ownership is enforced on every read: a META item for a foreign principal returns null (episodeStore.ddb.ts:75). **TTL attribute: `ttl`**, a number set to now plus `RETENTION_DAYS` in epoch seconds (episodeStore.ddb.ts:41, ceilings.ts:66). `RETENTION_DAYS` is 7. Enable DynamoDB TTL on the `ttl` attribute so expired episodes delete themselves.

### Tasks table (default `overhear-tasks`)

This table backs both the durable task store and the task message queue (main.ts:52, main.ts:59):

| `pk`                  | `sk`            | item                                                               |
| --------------------- | --------------- | ------------------------------------------------------------------ |
| `{scope}`             | `{taskId}`      | one async task, status, request and result JSON (taskStore.ts:105) |
| `Q#{scope}#{taskId}`  | zero-padded seq | one queued message (messageQueue.ts:81)                            |
| `QC#{scope}#{taskId}` | `C`             | per-queue sequence counter (messageQueue.ts:46)                    |

`{scope}` is the resolved bearer principal, so a `QueryCommand` on the task partition reads exactly one owner's tasks (taskStore.ts:36, taskStore.ts:241). Status transitions use conditional `UpdateCommand`s (taskStore.ts:160). **TTL attribute: `expiresAt`**, epoch seconds set from the capped task TTL (taskStore.ts:104). Only task items carry `expiresAt`; queue messages and counters are removed explicitly by the dequeue path (messageQueue.ts:106, messageQueue.ts:128), not by TTL. Enable DynamoDB TTL on `expiresAt`.

### Events table (default `overhear-events`)

The resumable MCP event log, so a dropped SSE stream can replay (eventStore.ts:31):

| `pk`           | `sk`            | item                                                      |
| -------------- | --------------- | --------------------------------------------------------- |
| `S#{streamId}` | padded event id | one stored event message (eventStore.ts:75)               |
| `E#{eventId}`  | `E`             | index from event id back to its stream (eventStore.ts:79) |
| `C#GLOBAL`     | `C`             | monotonic global sequence counter (eventStore.ts:24)      |

A global counter hands out the sequence with an atomic `ADD` `UpdateCommand` (eventStore.ts:50), then the event and its index are written in one `TransactWriteCommand` (eventStore.ts:70). Replay is a `QueryCommand` with `sk > lastEventId` on the stream partition (eventStore.ts:113). This table sets no TTL attribute in code, so its items persist until deleted. A deployment that wants them to age out can add a numeric TTL attribute and a lifecycle of its own; the server does not depend on one.

## S3 object layout, encryption and lifecycle

- **Keys.** One object per audio part under a single prefix: `ep/{episodeId}/{partId}.mp3`, content type `audio/mpeg` (storage.ts:108). No other prefix is written, so the policy and the lifecycle rule both scope to `ep/*`.
- **Encryption.** Each `PutObjectCommand` sets `ServerSideEncryption: "AES256"`, which is SSE-S3 with S3-managed keys and no KMS cost or KMS permission (storage.ts:115). Set the bucket default encryption to SSE-S3 as well so a put that ever omits the header is still encrypted.
- **No public objects.** Bytes are reachable only through a presigned GET that expires after 15 minutes (storage.ts:121, ceilings.ts:62). Turn on S3 Block Public Access at all four settings; the server needs no public object and no bucket policy that grants anonymous read.
- **Lifecycle.** The DynamoDB records expire after `RETENTION_DAYS` (7). Add an S3 lifecycle rule that expires objects under `ep/` after the same 7 days so audio does not outlive its episode metadata.

## Least-privilege IAM policy

The policy below grants exactly the actions the adapters call and nothing wider. Replace `${REGION}`, `${ACCOUNT_ID}` and `${BUCKET}` with your values. Replace the three `table/...` names too if you overrode them with env. Attach it to the role or user the server runs as.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockConverseChosenModels",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:${REGION}::foundation-model/amazon.nova-lite-v1:0",
        "arn:aws:bedrock:${REGION}::foundation-model/amazon.nova-pro-v1:0"
      ]
    },
    {
      "Sid": "PollyGenerativeSynthesis",
      "Effect": "Allow",
      "Action": "polly:SynthesizeSpeech",
      "Resource": "*"
    },
    {
      "Sid": "S3EpisodeAudioObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/ep/*"
    },
    {
      "Sid": "DynamoEpisodesTable",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/overhear"
    },
    {
      "Sid": "DynamoTasksTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/overhear-tasks"
    },
    {
      "Sid": "DynamoEventsTable",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/overhear-events"
    }
  ]
}
```

Notes on the scoping:

- **Bedrock** is pinned to the two configured foundation-model ids (config.ts:54). Converse is a non-streaming call, so only `bedrock:InvokeModel` is needed, not the streaming action. A foundation-model ARN carries no account id, hence the empty account field. If you set `OVERHEAR_PLAN_MODEL` or `OVERHEAR_SCRIPT_MODEL` to a cross-region inference profile id instead of a bare model id, add that profile ARN and the underlying foundation-model ARNs it routes to.
- **Polly** `SynthesizeSpeech` carries no resource-level ARN, so `"*"` is the tightest grant the action allows. It is the only Polly call in the code (polly.ts:62).
- **S3** is limited to object `Put` and `Get` under the one `ep/*` prefix. No bucket-level action is needed: there is no list, no delete and no bucket-policy call in the code.
- **DynamoDB** lists per table only the item actions each one calls. Episodes needs `DeleteItem` for the part-replacement path (episodeStore.ddb.ts:207); tasks needs it for the queue dequeue (messageQueue.ts:106); events never deletes. The events `TransactWriteCommand` is covered by `PutItem` on that table. No table uses a secondary index, so no index ARN is granted. TTL deletes are performed by DynamoDB itself and need no permission on this role.

## Cost per episode

No dollar figures are quoted here on purpose. AWS unit prices change by region and over time, so read them live from the pricing pages below and plug them into the formula. Everything is expressed per episode, with the code ceilings as the upper bounds.

Per-episode cost is the sum of four parts.

**Bedrock (text).** One plan call plus one script or expand call per part. For each model call `c` with input tokens `Tin(c)` and output tokens `Tout(c)`, priced at `pin` and `pout` per 1K tokens for the chosen Nova model:

```
Cost_bedrock = sum over calls c of ( Tin(c)/1000 * pin + Tout(c)/1000 * pout )
```

**Polly (speech).** Generative synthesis is priced per character. With `Nchar` characters of script synthesised and `ppolly` the generative per-character price:

```
Cost_polly = Nchar * ppolly
```

The script ceiling is `MAX_PARTS * MAX_LINES_PER_PART * MAX_LINE_CHARS = 8 * 20 * 600 = 96,000` characters per episode (ceilings.ts:17, ceilings.ts:22, ceilings.ts:21), so `Nchar <= 96000`.

**S3.** With `Nobj` part objects written, `Bytes` total stored, `Nget` presigned fetches and `Dbytes` bytes downloaded:

```
Cost_s3 = Nobj * pput + Nget * pget
        + (Bytes/1e9) * pstore_GBmo * (RETENTION_DAYS/30)
        + (Dbytes/1e9) * pxfer
```

`RETENTION_DAYS` is 7 (ceilings.ts:66), so the storage term is roughly a quarter of a month.

**DynamoDB (on-demand).** Creating an episode writes `3 + Nparts` items (META, SRC, principal index and one per part) at episodeStore.ddb.ts:123, plus task and event items on their own tables. With `Wru` write request units, `Rru` read request units and `Bddb` bytes stored:

```
Cost_ddb = Wru * pwru + Rru * prru + (Bddb/1e9) * pddb_store_GBmo * (RETENTION_DAYS/30)
```

TTL deletions are free, so retention costs only storage, not delete throughput.

```
Cost_episode = Cost_bedrock + Cost_polly + Cost_s3 + Cost_ddb
```

Read the current unit prices from:

- Amazon Bedrock pricing: https://aws.amazon.com/bedrock/pricing/
- Amazon Polly pricing: https://aws.amazon.com/polly/pricing/
- Amazon S3 pricing: https://aws.amazon.com/s3/pricing/
- Amazon DynamoDB pricing: https://aws.amazon.com/dynamodb/pricing/

## Run against real AWS

1. **Sign in.** Give the shell AWS credentials the way your org does (for instance `aws sso login` then export the profile) or `aws configure`. Confirm with `aws sts get-caller-identity`. The server reads credentials only through the default SDK chain, never from its own config.
2. **Enable Bedrock model access.** In the Bedrock console for your region, enable access to the Nova models you configured (`amazon.nova-lite-v1:0` and `amazon.nova-pro-v1:0` by default). Confirm the Polly generative engine and your configured voice ids are available in that region (voice list in the Amazon Polly docs).
3. **Provision the resources.** Create the S3 bucket with Block Public Access on and SSE-S3 default encryption. Add the `ep/` lifecycle rule. Create the three DynamoDB tables with `pk`/`sk` string keys, on-demand capacity and TTL enabled on `ttl` (episodes) and `expiresAt` (tasks). The server never creates any of these (common.ts:18).
4. **Set a budget alarm first.** Before the first paid call, create an AWS Budget with an alert threshold so a runaway loop cannot surprise you. See https://aws.amazon.com/aws-cost-management/aws-budgets/.
5. **Attach the IAM policy** above to the server's role or user.
6. **Set the env and start.** The config reads these (config.ts):

```bash
export OVERHEAR_MODELS=aws          # Bedrock + Polly
export OVERHEAR_STORE=aws           # S3 + DynamoDB
export AWS_REGION=us-east-1         # or OVERHEAR_REGION
export OVERHEAR_S3_BUCKET=your-bucket-name
export OVERHEAR_TABLE_EPISODES=overhear
export OVERHEAR_TABLE_TASKS=overhear-tasks
export OVERHEAR_TABLE_EVENTS=overhear-events
# optional overrides
export OVERHEAR_PLAN_MODEL=amazon.nova-lite-v1:0
export OVERHEAR_SCRIPT_MODEL=amazon.nova-pro-v1:0
export OVERHEAR_VOICE_EXPLAINER_HOST=Ruth
```

`OVERHEAR_S3_BUCKET` has no default, so it must be set or every S3 call fails (config.ts:58). The startup banner prints the resolved modes so the run mode is never ambiguous (config.ts:79).
