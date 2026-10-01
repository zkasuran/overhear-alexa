// Pure time-left maths for the producer's "how long is left" answer. The browser reports the current
// playback position; the host knows the total from the manifest (actual audio seconds once rendered,
// planned estimate before). No model call: this is a meta intent the bridge resolves on its own.

export type TimeLeft = {
  elapsedSeconds: number;
  remainingSeconds: number;
  totalSeconds: number;
  speakable: string;
};

function spokenDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} seconds`;
  const mins = Math.round(whole / 60);
  return mins === 1 ? "about a minute" : `about ${mins} minutes`;
}

export function computeTimeLeft(positionSeconds: number, totalSeconds: number): TimeLeft {
  const total = Math.max(0, totalSeconds);
  const elapsed = Math.min(Math.max(0, positionSeconds), total);
  const remaining = Math.max(0, total - elapsed);
  const speakable =
    remaining <= 0
      ? "That is the end of the episode."
      : `${spokenDuration(remaining)} left, out of ${spokenDuration(total)}.`;
  return {
    elapsedSeconds: Math.round(elapsed),
    remainingSeconds: Math.round(remaining),
    totalSeconds: Math.round(total),
    speakable,
  };
}
