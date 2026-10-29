import fs from 'node:fs';
import path from 'node:path';

import type { Config } from './config.ts';
import { openStore, type Store } from './store/store.ts';
import { loadAgents, loadChatAgent, loadSkills } from './agents/load.ts';
import { whatHappenedTo } from './agents/brief.ts';
import { createOrchestrator, type Orchestrator } from './orchestrator/loop.ts';
import { createStageRunner } from './run/runStage.ts';
import { createChatRunner } from './run/chat.ts';
import { createNameChecker } from './run/nameCheck.ts';
import { createEstimator, estimateAsTicketsMove } from './run/estimate.ts';
import { createWarmPool } from './run/warmPool.ts';
import { describeEngine, engineFor, engineSettings } from './run/engine.ts';
import { cachedCredentials, providerCredentials } from './run/credentials.ts';
import { createFakeRunner } from './run/fakeRunner.ts';
import { createFakeChatRunner } from './run/fakeChatRunner.ts';
import { createCheckRunner } from './run/checks.ts';
import { diff, gitWorkspace, worktreeFor } from './git/worktree.ts';
import { githubHost } from './github/pr.ts';
import { createApi } from './api/server.ts';

/**
 * What the project is, read once at startup rather than per stage. Absent is fine
 * and means the section is simply not in the brief — better than a heading with an
 * apology under it.
 */
function readAbout(config: Config): string {
  try {
    return fs.readFileSync(path.resolve(config.repoRoot, config.about), 'utf8');
  } catch {
    return '';
  }
}

export type Workbench = {
  store: Store;
  orchestrator: Orchestrator;
  /** What the API is really listening on, which is not `config.port` when that is 0. */
  port: number;
  close: () => Promise<void>;
};

/**
 * The composition root: the one place that knows every module, and the file to read
 * to see how the workbench is put together. It decides nothing and prints nothing —
 * `announce` is where anything it has to say comes out.
 *
 * The orchestrator is wired but not started, so the caller can say what it found
 * before work begins.
 */
export async function startWorkbench(
  config: Config,
  announce: (message: string) => void,
): Promise<Workbench> {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const store = openStore(config.dbPath);
  // Read once here so a broken agent file stops the workbench starting rather than
  // failing the first stage that needs it; read again per run, because the board
  // edits them.
  loadAgents(config.agentDirs);
  loadChatAgent(config.agentDirs);
  const agents = () => loadAgents(config.agentDirs);
  const fake = config.runner === 'fake';

  /**
   * Which model service the stages talk to, and the engine that talks to it. Built once:
   * the same engine serves every stage, every conversation about a ticket and every
   * one-shot question, through the dependency each of those three already took so a test
   * could answer without a network. A project that says nothing about this gets `claude`
   * and the SDK, exactly as it did before.
   */
  const settings = engineSettings(config, process.env);
  const engine = engineFor(settings, {
    protectedPaths: config.protectedPaths,
    pluginRoot: config.pluginRoot,
  });
  // Said once, at the moment it could still be wrong. A board quietly running on a
  // model nobody chose is the same class of surprise as a board quietly running on an
  // account nobody chose, and the fix for that is why `wb serve` already says which
  // credential every stage used.
  if (settings.provider !== 'claude') announce(`model service: ${describeEngine(settings)}`);

  const orchestrator = createOrchestrator(
    {
      store,
      announce,
      workspace: gitWorkspace(config),
      host: githubHost(config),
      checks: createCheckRunner(config.checks),
      runStage: fake
        ? createFakeRunner({ agents, protectedPaths: config.protectedPaths })
        : createStageRunner({
            agents,
            protectedPaths: config.protectedPaths,
            pluginRoot: config.pluginRoot,
            skills: () => loadSkills(config.pluginRoot),
            about: readAbout(config),
            diff: (ticket, _worktree, from) =>
              diff(config, worktreeFor(config, ticket.id), from ?? ticket.base, ticket.carrying),
            continued: (ticketId) =>
              whatHappenedTo(store.ticket(ticketId), store.eventsFor(ticketId)),
            query: engine,
          }),
      modelFor: (stage) => agents()[stage].model,
      // Fake agents need no credentials: nothing they do leaves this machine.
      credentials: fake
        ? async () => ({ ok: true, how: 'fake agents' })
        : settings.provider === 'claude'
          ? cachedCredentials()
          : // A workbench pointed at a local server has no Claude login to find, and
            // asking the Claude CLI about it would be asking the wrong machine.
            cachedCredentials(async () =>
              providerCredentials({
                provider: settings.provider,
                baseUrl: settings.baseUrl,
                apiKey: settings.apiKey,
              }),
            ),
    },
    { pollMs: config.pollMs },
  );

  // Where a one-shot question is asked from, and nothing is running in it until
  // something asks for it to be — a board nobody is writing a ticket on holds no
  // subprocess open.
  const pool = fake ? undefined : createWarmPool({ run: engine });

  // The conversation about a ticket, and the process it keeps alive between the
  // turns of one. Unlike the pool above it can start nothing until it is told which
  // ticket it is for: what a chat process is bound to at spawn is that ticket's.
  const chats = fake
    ? undefined
    : createChatRunner({
        agent: () => loadChatAgent(config.agentDirs),
        // A ticket has no worktree until it starts, and a conversation about one
        // that has not started is a conversation about this repository.
        cwd: (ticket) => {
          const worktree = worktreeFor(config, ticket.id).path;
          return fs.existsSync(worktree) ? worktree : config.repoRoot;
        },
        protectedPaths: config.protectedPaths,
        about: readAbout(config),
        query: engine,
      });

  // How long a ticket is likely to take, guessed as it moves rather than when
  // somebody looks: the moments worth guessing at — queued, and each stage
  // finishing — are moments nobody is watching, so the answer is written down.
  const stopEstimating =
    pool === undefined
      ? undefined
      : estimateAsTicketsMove(store, createEstimator(config, store, pool.ask));

  // Fake agents spend nothing, and a name check is a model call like any other:
  // trying the workbench out must not be the one thing that quietly costs money.
  const api = createApi(store, config, {
    orchestrator,
    chat: chats === undefined ? createFakeChatRunner() : chats.chat,
    ...(chats === undefined ? {} : { warmChat: chats.warm }),
    ...(pool === undefined
      ? {}
      : { checkName: createNameChecker(config, pool.ask), warmNameCheck: pool.warm }),
  });
  const port = await api.listen(config.port);

  return {
    store,
    orchestrator,
    port,
    close: async () => {
      // First, so that nothing being stopped below starts one more question.
      stopEstimating?.();
      await orchestrator.stop();
      await api.close();
      await pool?.close();
      // After the API, so a turn still in flight has ended: a chat process that
      // outlives `wb serve` is a subprocess nothing can reach to stop.
      await chats?.close();
      store.close();
    },
  };
}
