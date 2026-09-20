import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { CheckRun } from '../domain/events.ts';

const run = promisify(exec);

/** Long enough for a real suite, short enough that a hung check cannot wedge a ticket. */
const TIMEOUT_MS = 10 * 60_000;

/** Enough of a failure to act on, without putting a whole test run in the database. */
const KEEP_CHARS = 4_000;

/**
 * Runs the standing checks in a ticket's worktree.
 *
 * `exec` rather than `execFile`: these are shell command strings out of the config,
 * and `PYTHONDONTWRITEBYTECODE=1 python3 -m compileall .` means nothing without a
 * shell. They come from the operator's own config file, never from an agent.
 *
 * Nothing throws. A command that fails, times out, or does not exist at all comes
 * back as `ok: false` with the reason as its output — because to everything above
 * here they are the same thing: the checks did not pass.
 */
export function createCheckRunner(checks: readonly string[]) {
  return async function runChecks(worktree: string): Promise<CheckRun[]> {
    const results: CheckRun[] = [];

    for (const command of checks) {
      try {
        const { stdout, stderr } = await run(command, {
          cwd: worktree,
          timeout: TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
        results.push({ command, ok: true, output: keepTail(stdout, stderr) });
      } catch (error) {
        results.push({ command, ok: false, output: describe(error) });
      }
    }

    return results;
  };
}

/**
 * What a failed command said. `exec` puts the output on the error rather than
 * throwing it away, and that output is the whole point: it becomes the reason the
 * ticket goes back to planning, so a bare "exit 1" would waste the trip.
 */
function describe(error: unknown): string {
  const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const said = keepTail(
    typeof failure.stdout === 'string' ? failure.stdout : '',
    typeof failure.stderr === 'string' ? failure.stderr : '',
  );
  // What it printed, when it printed anything: that is the explanation, and the
  // caller has already said which command it was. Node's own message only repeats
  // the command back, so it is the fallback for the silent failures — a timeout, or
  // a command that was never there to run.
  if (said !== '') return said;
  return typeof failure.message === 'string' ? failure.message : 'it failed';
}

/**
 * The end of the output: a failure explains itself at the bottom, not the top.
 *
 * Exported because a check the code host ran is trimmed the same way: it becomes the
 * same change list, and a whole Actions log in the database is the same waste.
 */
export function keepTail(stdout: string, stderr: string): string {
  const both = [stdout.trim(), stderr.trim()].filter((s) => s !== '').join('\n');
  return both.length <= KEEP_CHARS ? both : `…\n${both.slice(-KEEP_CHARS)}`;
}
