// Where the UI reaches the simulator host, plus the client-side ceilings. These hosts are fixed at
// build time because the Content-Security-Policy connect-src is generated from them: changing the host
// means rebuilding, so the policy and the code can never drift. The browser only ever talks to the
// host; the episode server is reached through the host's media proxy.

export const SIM_HOST_HOST = "127.0.0.1";
export const SIM_HOST_PORT = 8788;

export const WS_URL = `ws://${SIM_HOST_HOST}:${SIM_HOST_PORT}/ws`;
export const MEDIA_BASE = `http://${SIM_HOST_HOST}:${SIM_HOST_PORT}`;

/** Every audio fetch is bounded in time and size so a slow or hostile response cannot hang the UI. */
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Episode gain, and the ducked level when the producer speaks over it (about -15 dB). */
export const EPISODE_GAIN = 1;
export const DUCK_GAIN = 0.18;
export const GAIN_RAMP_SECONDS = 0.25;

/** The quiet pad that covers a stall so a gap between parts is never dead silence. */
export const FILLER_GAIN = 0.03;

/** Reconnect backoff bounds for the control socket. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;

/** Input caps mirrored from the host so the UI never sends something the server will refuse. */
export const MAX_QUESTION_CHARS = 300;
export const MAX_TOPIC_CHARS = 400;
