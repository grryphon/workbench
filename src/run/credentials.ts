import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Whether the workbench can reach the model service. `how` names the credential in
 * the user's own words, so a surprise is visible; `fix` says what to do about it.
 */
export type Credentials = { ok: true; how: string } | { ok: false; why: string; fix: string };

/** What `claude auth status --json` prints. Only the fields we act on. */
type AuthStatus = { loggedIn?: unknown; authMethod?: unknown };

// The two ways this can be answered "no". Both carry the fix, because a reason
// without one is just bad news.

/** No credential was found at all. */
export function notSetUp(why: string): Credentials {
  return {
    ok: false,
    why,
    fix: [
      'Pick one:',
      '',
      '  claude setup-token            a long-lived token from your Claude subscription.',
      '                                No browser after this, and it works in a container.',
      '  claude auth login             sign in on this machine. Expires, and renewing it',
      '                                needs a browser.',
      '  export ANTHROPIC_API_KEY=...  a Console key, billed per token.',
    ].join('\n'),
  };
}

/**
 * A credential that exists and was refused by the model service — the one kind of
 * failure no local check can find, and the one kind that cannot fix itself.
 */
export function refused(why: string): Credentials {
  return {
    ok: false,
    why,
    fix: [
      'The credential is there but the model service will not accept it. Check that a',
      '`claude setup-token` token is in CLAUDE_CODE_OAUTH_TOKEN — ANTHROPIC_AUTH_TOKEN',
      'looks equally valid locally and is rejected by the API.',
      '',
      'Fix it, and restart any workbench already running: an environment variable',
      'cannot change under a running process.',
    ].join('\n'),
  };
}

/**
 * The environment variables that authenticate, in the order they win. Anything
 * here outranks what the CLI has stored, which is exactly why the workbench names
 * the one it used: a forgotten value in a shell profile is how a workbench ends up
 * quietly working as an account nobody meant it to use.
 *
 * `claude setup-token` hands you a token rather than storing one, and it belongs in
 * `CLAUDE_CODE_OAUTH_TOKEN`. The similarly-named `ANTHROPIC_AUTH_TOKEN` is a bearer
 * token for direct API calls: putting an `sk-ant-oat01-` token there is well-formed,
 * accepted by everything local, and rejected by the API with "OAuth access token is
 * invalid" three minutes into the first stage.
 */
const FROM_ENVIRONMENT = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/** The credential in the environment, if there is one. Pure, and asked first. */
export function fromEnvironment(env: NodeJS.ProcessEnv): Credentials | undefined {
  for (const name of FROM_ENVIRONMENT) {
    if ((env[name] ?? '').trim() !== '') return { ok: true, how: `${name} from the environment` };
  }
  return undefined;
}

/**
 * What the CLI says about itself. Pure, so the interesting part is tested without
 * spawning anything.
 *
 * @param raw stdout from `claude auth status --json`
 */
export function readAuthStatus(raw: string): Credentials {
  let status: AuthStatus;
  try {
    status = JSON.parse(raw) as AuthStatus;
  } catch {
    return notSetUp(`could not read what "claude auth status" said: ${raw.trim().slice(0, 120)}`);
  }

  if (status.loggedIn !== true) return notSetUp('the Claude CLI is not logged in');

  const method = typeof status.authMethod === 'string' ? status.authMethod.trim() : '';
  return { ok: true, how: method === '' ? 'the Claude CLI login' : `the Claude CLI (${method})` };
}

/** Costs nothing and spends no tokens: it asks the CLI, it does not call the model. */
export async function checkCredentials(env = process.env): Promise<Credentials> {
  const inEnvironment = fromEnvironment(env);
  if (inEnvironment) return inEnvironment;

  try {
    const { stdout } = await run('claude', ['auth', 'status', '--json'], { timeout: 15_000 });
    return readAuthStatus(stdout);
  } catch (error) {
    // Being logged out is reported as a failure — exit 1 — with the answer still on
    // stdout. So a non-zero exit is not the same as not knowing: read what it said
    // before deciding the command itself is broken.
    const said = stdoutOf(error);
    if (said.trim() !== '') return readAuthStatus(said);

    return notSetUp(
      `could not run "claude auth status": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The credential for a workbench that is not talking to Claude.
 *
 * Everything above this function asks the Claude CLI what it thinks, which is the right
 * question to ask when the Claude CLI is the thing doing the work and exactly the wrong
 * one when it is not: a workbench pointed at a local server has no `claude` login to
 * find and should not be told it needs one.
 *
 * What is checked is that there is a key where the provider looks for one, or that the
 * address is a machine on this box, where a key is ordinarily nobody's business. Whether
 * the key is *accepted* is a separate question, and `verifyEngine` is what spends the
 * call that answers it.
 */
export function providerCredentials(p: {
  provider: string;
  baseUrl: string;
  apiKey: string;
}): Credentials {
  if (p.apiKey !== '') return { ok: true, how: `${keyName()} for ${p.provider} at ${p.baseUrl}` };

  if (isLocal(p.baseUrl)) {
    return { ok: true, how: `no key, which is normal for ${p.baseUrl}` };
  }

  return {
    ok: false,
    why: `${p.provider} at ${p.baseUrl} has no key to send`,
    fix: [
      'Pick one:',
      '',
      '  export WB_API_KEY=...      the workbench’s own variable.',
      '  export OPENAI_API_KEY=...  read too, since everything else on this machine',
      '                             already puts the key there.',
      '',
      'A server on this machine (http://127.0.0.1:..., http://localhost:...) needs',
      'neither, and runs without one.',
    ].join('\n'),
  };
}

function keyName(): string {
  return (process.env['WB_API_KEY'] ?? '') !== '' ? 'WB_API_KEY' : 'OPENAI_API_KEY';
}

/** A service on this machine, which is where most people run their own models. */
function isLocal(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

/**
 * Actually uses the credential, rather than noting that there is one.
 *
 * Finding a credential is cheap and proves nothing: a well-formed token in the
 * wrong variable, or a stale one, passes every local check and is refused by the
 * API three minutes into the first stage. `wb auth` exists to answer "am I set
 * up?", and the only honest answer costs a fraction of a penny on the cheapest
 * model there is. This is deliberately not done on every `wb serve` — it belongs
 * in the command you run when you want the truth.
 */
export async function verifyCredentials(): Promise<Credentials> {
  const found = await checkCredentials();
  if (!found.ok) return found;

  try {
    await run('claude', ['-p', 'Reply with: ok', '--model', 'claude-haiku-4-5'], {
      timeout: 90_000,
    });
    return found;
  } catch (error) {
    const said = `${stdoutOf(error)} ${error instanceof Error ? error.message : ''}`.trim();
    return refused(
      `${found.how} was refused: ${said.split('\n')[0]?.slice(0, 200) ?? 'no reason given'}`,
    );
  }
}

/**
 * Whether a failed run failed because the credential was refused, rather than
 * because of anything about the ticket.
 *
 * Finding a credential is not the same as it being accepted, and only a real call
 * settles that. This is how the answer gets back: without it, a rejected credential
 * looks like one ticket having a bad day, and the workbench cheerfully spends a
 * stage discovering the same thing on every other ticket in the queue.
 */
export function isCredentialRejection(summary: string): boolean {
  return /failed to authenticate|401|oauth.*invalid|invalid.*(api key|token)|unauthori[sz]ed/i.test(
    summary,
  );
}

function stdoutOf(error: unknown): string {
  const said = (error as { stdout?: unknown } | null)?.stdout;
  return typeof said === 'string' ? said : '';
}

/**
 * The orchestrator asks before every stage, and a tick asks for several tickets at
 * once. Without this that is a subprocess each time, for an answer that changes
 * about as often as you log in.
 */
export function cachedCredentials(
  check: () => Promise<Credentials> = checkCredentials,
  ttlMs = 5_000,
): () => Promise<Credentials> {
  let answer: Promise<Credentials> | undefined;
  let asked = 0;

  return () => {
    const now = Date.now();
    if (answer === undefined || now - asked > ttlMs) {
      asked = now;
      answer = check();
    }
    return answer;
  };
}
