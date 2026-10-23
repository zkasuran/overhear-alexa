// The ONLY module that reads process.env. Builds a validated Config once at boot. Everything else
// receives config through the Services bundle. Two independent switches, both printed in the banner.

import { PRESIGN_TTL_SECONDS } from "@overhear/core";
import type { Config, Logger } from "./contracts.js";
import type { FormatId, Speaker } from "@overhear/core";

function pick<T extends string>(v: string | undefined, allowed: readonly T[], dflt: T): T {
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

// Polly generative voice ids per format and speaker. Defaults are a reasonable starting set; the real
// generative voices available on the account can be confirmed and overridden with env. Mock mode
// ignores these entirely.
const DEFAULT_VOICES: Record<FormatId, Record<Speaker, string>> = {
  explainer: { host: "Ruth", expert: "Matthew" },
  debate: { host: "Danielle", expert: "Stephen" },
  cozy: { host: "Joanna", expert: "Stephen" },
  hype: { host: "Danielle", expert: "Matthew" },
};

function voicesFromEnv(env: NodeJS.ProcessEnv): Record<FormatId, Record<Speaker, string>> {
  const out = structuredClone(DEFAULT_VOICES);
  for (const f of Object.keys(out) as FormatId[]) {
    for (const s of ["host", "expert"] as Speaker[]) {
      const key = `OVERHEAR_VOICE_${f.toUpperCase()}_${s.toUpperCase()}`;
      const v = env[key];
      if (v) out[f][s] = v;
    }
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modelsMode = pick(env.OVERHEAR_MODELS, ["mock", "aws"] as const, "mock");
  const storeMode = pick(env.OVERHEAR_STORE, ["local", "aws"] as const, "local");

  // Mock models with an AWS store is nonsense (fixtures written to DynamoDB): refuse it at boot.
  if (storeMode === "aws" && modelsMode === "mock") {
    throw new Error("OVERHEAR_STORE=aws requires OVERHEAR_MODELS=aws (refusing mock+aws-store)");
  }

  const bindPublic = env.OVERHEAR_BIND_PUBLIC === "1";
  const originAllowlist = (env.OVERHEAR_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    modelsMode,
    storeMode,
    region: env.AWS_REGION ?? env.OVERHEAR_REGION ?? "us-east-1",
    bedrock: {
      planModelId: env.OVERHEAR_PLAN_MODEL ?? "amazon.nova-lite-v1:0", // default; override with env
      scriptModelId: env.OVERHEAR_SCRIPT_MODEL ?? "amazon.nova-pro-v1:0", // default; override with env
    },
    voices: voicesFromEnv(env),
    s3Bucket: env.OVERHEAR_S3_BUCKET ?? "",
    tables: {
      episodes: env.OVERHEAR_TABLE_EPISODES ?? "overhear",
      tasks: env.OVERHEAR_TABLE_TASKS ?? "overhear-tasks",
      events: env.OVERHEAR_TABLE_EVENTS ?? "overhear-events",
    },
    bind: {
      host: bindPublic ? "0.0.0.0" : "127.0.0.1",
      port: Number(env.OVERHEAR_PORT ?? "8787"),
    },
    bindPublic,
    originAllowlist,
    tokenFile: env.OVERHEAR_TOKENS_FILE ?? "fixtures/test-token",
    mediaDir: env.OVERHEAR_MEDIA_DIR ?? ".media",
    dataDir: env.OVERHEAR_DATA_DIR ?? ".data",
    bedsDir: env.OVERHEAR_BEDS_DIR ?? "assets/beds",
    presignTtlSeconds: PRESIGN_TTL_SECONDS,
  };
}

/** One-line-per-fact startup banner so the run mode is never ambiguous in a log or a demo. */
export function bannerLines(c: Config): string[] {
  return [
    `overhear server  models=${c.modelsMode}  store=${c.storeMode}  region=${c.region}`,
    `bind=${c.bind.host}:${c.bind.port}${c.bindPublic ? "  (PUBLIC)" : ""}  origins=[${c.originAllowlist.join(",")}]`,
    `tokens=${c.tokenFile}  presignTtl=${c.presignTtlSeconds}s`,
  ];
}

export function printBanner(c: Config, log: Logger): void {
  for (const line of bannerLines(c)) log.info(line);
}
