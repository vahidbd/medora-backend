import type { JobLogger } from '../../src/lib/jobs.js';

/** A logger that keeps what it was told, for tests that check what a job reported. */
export function recordingLog(): JobLogger & { lines: { level: string; message: string | undefined; details: object }[] } {
  const lines: { level: string; message: string | undefined; details: object }[] = [];
  const at = (level: string) => (details: object, message?: string) => {
    lines.push({ level, message, details });
  };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}
