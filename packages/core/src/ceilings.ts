// Every ceiling in one place. Tests and runtime code import these constants, never a literal.
// A hostile input must never exhaust memory or CPU: see SECURITY.md.

/** Source text kept after extraction, in characters. */
export const MAX_SOURCE_CHARS = 50_000;

/** Source fetch (source.kind = "url"). */
export const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2 MB
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;

/** Episode length request, in minutes. */
export const MINUTES_MIN = 2;
export const MINUTES_MAX = 15;

/** Episode shape. */
export const MAX_PARTS = 8;
export const MAX_EXPANSIONS = 5; // per episode

/** Scripted dialogue. */
export const MAX_LINE_CHARS = 600;
export const MAX_LINES_PER_PART = 20;

/** Natural-language input caps. */
export const MAX_QUERY_CHARS = 200; // find_moment
export const MAX_QUESTION_CHARS = 300; // ask
export const MAX_FOCUS_CHARS = 200; // plan_episode focus
export const MAX_ANGLE_CHARS = 200; // expand_part angle
export const MAX_TITLE_CHARS = 60;
export const MAX_DEK_CHARS = 120;

/** Recap window. */
export const RECAP_SECONDS_MIN = 15;
export const RECAP_SECONDS_MAX = 60;

/** Tasks. */
export const TASK_TTL_MAX_MS = 3_600_000; // 1 h
export const TASK_POLL_INTERVAL_MS = 1_000;

/** Per-principal quotas. */
export const EPISODES_PER_DAY = 20;
export const CONCURRENT_TASKS = 2;
export const REQ_PER_MIN = 60;

/** Upstream timeouts. */
export const MODEL_TIMEOUT_MS = 30_000;
export const TTS_TIMEOUT_MS = 15_000;

/** Transport. */
export const JSON_BODY_MAX_BYTES = 256 * 1024; // 256 KB

/** Part audio bounds (render-ahead budget). Part 0 is short so first audio is fast. */
export const PART0_TARGET_SECONDS = 30;
export const PART_MIN_SECONDS = 45;
export const PART_MAX_SECONDS = 120;

/** Expansion audio bounds. */
export const EXPANSION_MIN_SECONDS = 45;
export const EXPANSION_MAX_SECONDS = 120;

/** Presigned URL lifetime (S3) and local media token bytes. */
export const PRESIGN_TTL_SECONDS = 15 * 60;
export const MEDIA_TOKEN_BYTES = 16;

/** Data retention. */
export const RETENTION_DAYS = 7;

/** Extractor safety: reject pathologically nested JSON before parsing. */
export const MAX_JSON_BRACE_DEPTH = 64;
