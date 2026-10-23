// The Overhear Alexa skill: a custom skill with the AudioPlayer interface that runs a real Echo against
// the same MCP server the simulator drives. Speech requests map to MCP tools (plan_episode,
// render_episode, expand_part, ask); AudioPlayer events walk the manifest so parts play back to back,
// including a deeper part that expand_part inserted while the episode played.
//
// Alexa gives a skill about 8 seconds to answer, while planning and voicing the first part take longer.
// So planning and rendering start in the background and each handler waits a bounded time for what it
// needs; when it is not ready yet, Alexa says so and keeps the session open for "play".

import type { AskResult, Manifest, ManifestPart, PlanInput, PlanResult } from "../mcp-client.js";
import type { Logger } from "../log.js";

/** The slice of OverhearClient the skill uses, so tests can pass a fake. */
export interface EpisodeApi {
  plan(input: PlanInput): Promise<PlanResult>;
  render(episodeId: string, fromPart?: number): Promise<void>;
  readManifest(episodeId: string): Promise<Manifest | undefined>;
  expandPart(episodeId: string, partId: string, angle?: string): Promise<ManifestPart | undefined>;
  ask(
    episodeId: string,
    question: string,
    at?: { partId: string; offsetMs: number },
  ): Promise<AskResult>;
}

type Listener = {
  episodeId?: string;
  title?: string;
  planning?: Promise<PlanResult | undefined>;
  pendingAsk?: { key: string; promise: Promise<AskResult | undefined> };
  partId?: string;
  offsetMs: number;
};

export type SkillOptions = {
  api: EpisodeApi;
  log: Logger;
  /** Public https origin that serves /media/:token (the tunnel in front of this process). */
  publicBase: string;
  /** How long a handler may wait on the server before answering Alexa. Under the 8 s limit. */
  waitMs?: number;
  /** The ask tool gets a longer window, since it is a single call with nothing to poll. */
  askWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export type AlexaResponse = { version: "1.0"; response: Json };

const TOKEN_SEP = "|";

export function makeSkill(opts: SkillOptions) {
  const listeners = new Map<string, Listener>();
  const waitMs = opts.waitMs ?? 5000;
  const askWaitMs = opts.askWaitMs ?? 6800;
  const pollMs = opts.pollMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const listenerFor = (userId: string): Listener => {
    let l = listeners.get(userId);
    if (!l) {
      l = { offsetMs: 0 };
      listeners.set(userId, l);
    }
    return l;
  };

  const say = (text: string, endSession: boolean, directives: Json[] = []): AlexaResponse => {
    const response: Json = { outputSpeech: { type: "PlainText", text } };
    if (!endSession)
      response.reprompt = {
        outputSpeech: { type: "PlainText", text: "Say play, or ask me about a topic." },
      };
    if (directives.length > 0) response.directives = directives;
    response.shouldEndSession = endSession;
    return { version: "1.0", response };
  };
  const only = (directives: Json[]): AlexaResponse => ({
    version: "1.0",
    response: directives.length > 0 ? { directives, shouldEndSession: true } : {},
  });

  const mediaUrl = (part: ManifestPart): string | undefined => {
    const url = part.audio?.url;
    if (!url) return undefined;
    return url.startsWith("/media/") ? `${opts.publicBase}${url}` : url;
  };

  const playDirective = (
    episodeId: string,
    part: ManifestPart,
    offsetMs: number,
    behavior: "REPLACE_ALL" | "ENQUEUE",
    previousToken?: string,
  ): Json | undefined => {
    const url = mediaUrl(part);
    if (!url) return undefined;
    const stream: Json = {
      url,
      token: `${episodeId}${TOKEN_SEP}${part.partId}`,
      offsetInMilliseconds: offsetMs,
    };
    if (previousToken !== undefined) stream.expectedPreviousToken = previousToken;
    return {
      type: "AudioPlayer.Play",
      playBehavior: behavior,
      audioItem: { stream, metadata: { title: part.heading, subtitle: "Overhear" } },
    };
  };

  const ordered = (m: Manifest): ManifestPart[] => [...m.parts].sort((a, b) => a.index - b.index);

  /** Poll the manifest until `pick` returns a part with audio, or the wait runs out. */
  const waitForPart = async (
    episodeId: string,
    pick: (parts: ManifestPart[]) => ManifestPart | undefined,
    budgetMs = waitMs,
  ): Promise<ManifestPart | undefined> => {
    const end = Date.now() + budgetMs;
    for (;;) {
      const m = await opts.api.readManifest(episodeId).catch(() => undefined);
      const p = m ? pick(ordered(m)) : undefined;
      if (p && p.status === "ready" && p.audio) return p;
      if (Date.now() >= end) return undefined;
      await sleep(pollMs);
    }
  };

  const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), ms);
    });
    try {
      return await Promise.race([p, t]);
    } finally {
      clearTimeout(timer);
    }
  };

  const parseToken = (token: unknown): { episodeId: string; partId: string } | undefined => {
    const t = str(token);
    if (!t) return undefined;
    const [episodeId, partId] = t.split(TOKEN_SEP);
    return episodeId && partId ? { episodeId, partId } : undefined;
  };

  /** Where the Echo is right now, from the request context, falling back to what we last saw. */
  const position = (
    env: Json,
    l: Listener,
  ): { episodeId?: string; partId?: string; offsetMs: number } => {
    const ap = rec(rec(env.context).AudioPlayer);
    const tok = parseToken(ap.token);
    const off = typeof ap.offsetInMilliseconds === "number" ? ap.offsetInMilliseconds : l.offsetMs;
    if (tok) return { ...tok, offsetMs: off };
    const out: { episodeId?: string; partId?: string; offsetMs: number } = { offsetMs: l.offsetMs };
    if (l.episodeId) out.episodeId = l.episodeId;
    if (l.partId) out.partId = l.partId;
    return out;
  };

  const startEpisode = (l: Listener, topic: string): void => {
    l.planning = (async () => {
      try {
        const plan = await opts.api.plan({ source: { kind: "topic", value: topic }, minutes: 3 });
        l.episodeId = plan.episodeId;
        l.title = plan.title;
        delete l.partId;
        l.offsetMs = 0;
        void opts.api.render(plan.episodeId).catch((err: unknown) => {
          opts.log.warn("alexa: render failed", { error: String(err) });
        });
        return plan;
      } catch (err) {
        opts.log.warn("alexa: plan failed", { error: String(err) });
        return undefined;
      }
    })();
  };

  const playFrom = async (
    l: Listener,
    episodeId: string,
    pick: (parts: ManifestPart[]) => ManifestPart | undefined,
    offsetMs: number,
    speech?: string,
    budgetMs = waitMs,
  ): Promise<AlexaResponse> => {
    const part = await waitForPart(episodeId, pick, budgetMs);
    if (!part)
      return say(
        "The hosts are still recording that part. Say play again in a few seconds.",
        false,
      );
    const d = playDirective(episodeId, part, offsetMs, "REPLACE_ALL");
    if (!d) return say("That part has no audio yet. Say play again in a moment.", false);
    l.episodeId = episodeId;
    l.partId = part.partId;
    l.offsetMs = offsetMs;
    if (speech) return say(speech, true, [d]);
    return only([d]);
  };

  // ---- intents ----

  const onPlan = async (l: Listener, topic: string | undefined): Promise<AlexaResponse> => {
    if (!topic)
      return say("What should the hosts talk about? Say, brief me on, and a topic.", false);
    startEpisode(l, topic);
    const plan = await withTimeout(l.planning ?? Promise.resolve(undefined), waitMs);
    if (plan) {
      const n = plan.parts.length;
      return say(
        `Here's ${plan.title}. ${n} parts, about ${Math.max(1, Math.round(plan.totalEstSeconds / 60))} minutes. Say play to start.`,
        false,
      );
    }
    return say(`Two hosts are writing an episode on ${topic}. Say play in a few seconds.`, false);
  };

  const onPlay = async (l: Listener): Promise<AlexaResponse> => {
    const started = Date.now();
    if (!l.episodeId && l.planning) await withTimeout(l.planning, 2000);
    if (!l.episodeId && l.planning)
      return say("The hosts are still writing the outline. Say play in a few seconds.", false);
    if (!l.episodeId) return say("There is no episode yet. Say, brief me on, and a topic.", false);
    return playFrom(l, l.episodeId, (ps) => ps[0], 0, undefined, waitMs - (Date.now() - started));
  };

  const onGoDeeper = async (env: Json, l: Listener): Promise<AlexaResponse> => {
    const pos = position(env, l);
    if (!pos.episodeId || !pos.partId)
      return say("Start an episode first, then ask me to go deeper.", false);
    const { episodeId, partId } = pos;
    void opts.api.expandPart(episodeId, partId).catch((err: unknown) => {
      opts.log.warn("alexa: expand failed", { error: String(err) });
    });
    return playFrom(
      l,
      episodeId,
      (ps) => ps.find((p) => p.partId === partId),
      pos.offsetMs,
      "Going deeper. The hosts are adding more on this, and it plays right after this part.",
    );
  };

  const onAsk = async (
    env: Json,
    l: Listener,
    question: string | undefined,
  ): Promise<AlexaResponse> => {
    const pos = position(env, l);
    if (!pos.episodeId) return say("Start an episode first, then ask me about it.", false);
    if (!question) return say("What would you like to know?", false);
    // The ask tool needs a position; before playback starts, that is the top of the first part.
    let at = pos.partId ? { partId: pos.partId, offsetMs: pos.offsetMs } : undefined;
    if (!at) {
      const first = (await opts.api.readManifest(pos.episodeId).catch(() => undefined))?.parts
        .slice()
        .sort((a, b) => a.index - b.index)[0];
      if (first) at = { partId: first.partId, offsetMs: 0 };
    }
    // Answering takes a model call plus a voice clip, which can run past Alexa's window. Keep the
    // call running; asking the same question again picks up the finished answer at once.
    const key = `${pos.episodeId}|${question.toLowerCase()}`;
    if (l.pendingAsk?.key !== key) {
      l.pendingAsk = {
        key,
        promise: opts.api.ask(pos.episodeId, question, at).catch((err: unknown) => {
          opts.log.warn("alexa: ask failed", { error: String(err) });
          return undefined;
        }),
      };
    }
    const result = await withTimeout(l.pendingAsk.promise, askWaitMs);
    const answer = result
      ? result.grounded
        ? result.answer
        : "The episode did not cover that."
      : "Still checking what they said. Ask me the same question again in a moment.";
    if (!pos.partId) return say(answer, false);
    const partId = pos.partId;
    return playFrom(
      l,
      pos.episodeId,
      (ps) => ps.find((p) => p.partId === partId),
      pos.offsetMs,
      answer,
    );
  };

  const step = async (env: Json, l: Listener, delta: 1 | -1 | 0): Promise<AlexaResponse> => {
    const pos = position(env, l);
    if (!pos.episodeId) return say("There is no episode playing.", false);
    const m = await opts.api.readManifest(pos.episodeId);
    if (!m) return say("I lost that episode. Start a new one.", false);
    const ps = ordered(m);
    const i = Math.max(
      0,
      ps.findIndex((p) => p.partId === pos.partId),
    );
    const target = ps[Math.min(ps.length - 1, Math.max(0, i + delta))];
    if (!target) return say("That's the end of the episode.", true);
    return playFrom(l, pos.episodeId, (all) => all.find((p) => p.partId === target.partId), 0);
  };

  const onTimeLeft = async (env: Json, l: Listener): Promise<AlexaResponse> => {
    const pos = position(env, l);
    if (!pos.episodeId) return say("There is no episode playing.", false);
    const m = await opts.api.readManifest(pos.episodeId);
    if (!m) return say("I lost that episode.", false);
    const ps = ordered(m);
    const i = Math.max(
      0,
      ps.findIndex((p) => p.partId === pos.partId),
    );
    let secs = 0;
    ps.slice(i).forEach((p, k) => {
      const len = p.audio?.seconds ?? p.estSeconds;
      secs += k === 0 ? Math.max(0, len - pos.offsetMs / 1000) : len;
    });
    const mins = Math.round(secs / 60);
    const text = mins <= 1 ? "About a minute left." : `About ${mins} minutes left.`;
    if (!pos.partId) return say(text, false);
    const partId = pos.partId;
    return playFrom(
      l,
      pos.episodeId,
      (all) => all.find((p) => p.partId === partId),
      pos.offsetMs,
      text,
    );
  };

  // ---- AudioPlayer events ----

  const onNearlyFinished = async (env: Json, l: Listener): Promise<AlexaResponse> => {
    const req = rec(env.request);
    const tok = parseToken(req.token);
    if (!tok) return only([]);
    const m = await opts.api.readManifest(tok.episodeId);
    if (!m) return only([]);
    const ps = ordered(m);
    const i = ps.findIndex((p) => p.partId === tok.partId);
    const next = i >= 0 ? ps[i + 1] : undefined;
    if (!next) return only([]);
    const part = await waitForPart(tok.episodeId, (all) =>
      all.find((p) => p.partId === next.partId),
    );
    if (!part) return only([]);
    const d = playDirective(tok.episodeId, part, 0, "ENQUEUE", str(req.token));
    l.episodeId = tok.episodeId;
    return only(d ? [d] : []);
  };

  const track = (env: Json, l: Listener): void => {
    const req = rec(env.request);
    const tok = parseToken(req.token);
    if (tok) {
      l.episodeId = tok.episodeId;
      l.partId = tok.partId;
    }
    if (typeof req.offsetInMilliseconds === "number") l.offsetMs = req.offsetInMilliseconds;
  };

  const HELP =
    "Say, brief me on, and any topic. Two hosts talk it through. While it plays, say, Alexa, tell overhear studio to go deeper, or, ask overhear studio what they said about something.";

  return {
    listeners,
    async handle(env: Json): Promise<AlexaResponse> {
      const req = rec(env.request);
      const type = str(req.type) ?? "";
      const userId =
        str(rec(rec(rec(env.context).System).user).userId) ??
        str(rec(rec(env.session).user).userId) ??
        "anon";
      const l = listenerFor(userId);
      opts.log.info("alexa request", { type, intent: str(rec(req.intent).name) });

      if (type === "LaunchRequest") {
        return say(
          "Welcome to Overhear, the podcast you can interrupt. What should the hosts talk about?",
          false,
        );
      }
      if (type === "SessionEndedRequest" || type === "System.ExceptionEncountered") return only([]);
      if (type.startsWith("AudioPlayer.")) {
        track(env, l);
        if (type === "AudioPlayer.PlaybackNearlyFinished") return onNearlyFinished(env, l);
        return only([]);
      }
      if (type.startsWith("PlaybackController.")) {
        if (type === "PlaybackController.NextCommandIssued") return step(env, l, 1);
        if (type === "PlaybackController.PreviousCommandIssued") return step(env, l, -1);
        if (type === "PlaybackController.PlayCommandIssued") {
          const pos = position(env, l);
          if (pos.episodeId && pos.partId) {
            const partId = pos.partId;
            return playFrom(
              l,
              pos.episodeId,
              (ps) => ps.find((p) => p.partId === partId),
              pos.offsetMs,
            );
          }
          return only([]);
        }
        if (type === "PlaybackController.PauseCommandIssued")
          return only([{ type: "AudioPlayer.Stop" }]);
        return only([]);
      }
      if (type !== "IntentRequest") return only([]);

      const intent = rec(req.intent);
      const name = str(intent.name) ?? "";
      const slot = (n: string): string | undefined =>
        str(rec(rec(intent.slots)[n]).value)?.trim() || undefined;

      switch (name) {
        case "PlanIntent":
          return onPlan(l, slot("topic"));
        case "PlayEpisodeIntent":
          return onPlay(l);
        case "GoDeeperIntent":
          return onGoDeeper(env, l);
        case "AskIntent":
          return onAsk(env, l, slot("question"));
        case "TimeLeftIntent":
          return onTimeLeft(env, l);
        case "AMAZON.NextIntent":
          return step(env, l, 1);
        case "AMAZON.PreviousIntent":
          return step(env, l, -1);
        case "AMAZON.StartOverIntent":
        case "AMAZON.RepeatIntent":
          return step(env, l, 0);
        case "AMAZON.PauseIntent":
          return only([{ type: "AudioPlayer.Stop" }]);
        case "AMAZON.ResumeIntent": {
          const pos = position(env, l);
          if (!pos.episodeId || !pos.partId) return onPlay(l);
          const partId = pos.partId;
          return playFrom(
            l,
            pos.episodeId,
            (ps) => ps.find((p) => p.partId === partId),
            pos.offsetMs,
          );
        }
        case "AMAZON.StopIntent":
        case "AMAZON.CancelIntent":
          return {
            version: "1.0",
            response: { directives: [{ type: "AudioPlayer.Stop" }], shouldEndSession: true },
          };
        case "AMAZON.HelpIntent":
          return say(HELP, false);
        case "AMAZON.LoopOnIntent":
        case "AMAZON.LoopOffIntent":
        case "AMAZON.ShuffleOnIntent":
        case "AMAZON.ShuffleOffIntent":
          return say("Overhear plays an episode in order, so that is not available.", true);
        default:
          return say("Say, brief me on, and a topic. Or say help.", false);
      }
    },
  };
}
