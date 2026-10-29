import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { promisify } from 'node:util';

import { CONFIG_FILE, findHome, loadConfig, PACKAGE_ROOT, type Config } from '../config.ts';
import { USAGE } from './usage.ts';
import { abandoning, draining } from './stopping.ts';
import { CHILD_ENV, offer, relaunch, taken } from './updating.ts';
import { reconcile } from '../orchestrator/loop.ts';
import { checkCredentials, verifyCredentials } from '../run/credentials.ts';
import { engineSettings, verifyEngine } from '../run/engine.ts';
import { startWorkbench } from '../workbench.ts';
import { createClient, type Client } from '../api/client.ts';
import { UI_DIST } from '../api/server.ts';
import { nextFree, occupantOf } from '../api/port.ts';
import { commitIn, compareUrl, install, installed, newest, short } from '../update.ts';
import { writeConfigFile } from '../api/settings.ts';
import { heldBy } from '../domain/rules.ts';
import { mergeCommitsRefusal } from '../github/pr.ts';
import type { Ticket } from '../domain/ticket.ts';

/**
 * A `.env` beside the workbench is loaded before anything reads the environment.
 * Putting a credential in a file and expecting it to work is the obvious thing to
 * do, and `export` in one terminal does not reach a workbench started in another.
 * Node does this natively, so it costs a line and no dependency.
 *
 * It is not committed — see .gitignore — and a ticket's worktree is a fresh
 * checkout of the branch, so it never appears in front of an agent.
 *
 * Read from the home, not from the workbench's own code: installed as a package that
 * would be `node_modules`, which is nobody's idea of where a credential goes.
 */
function loadEnvFile(home: string): void {
  // The repository root first, because that is where people put it.
  for (const file of [path.join(home, '..', '.env'), path.join(home, '.env')]) {
    if (fs.existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  if (command === undefined || command === '--help' || command === 'help') {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === 'init') return init(args[0]);

  const home = findHome();
  loadEnvFile(home ?? process.cwd());

  // Answered without a running workbench — and without a workbench at all — because it
  // is what you ask when nothing works. Requiring setup to diagnose setup is backwards.
  // It really uses the credential: "there is one" and "it is accepted" are different
  // answers, and this command is asked precisely when that difference matters.
  if (command === 'auth') {
    // Which model service is asked here rather than of the config the lines below load,
    // because this command is asked before there is a workbench at all — and because
    // asking the Claude CLI whether a key for a local server works is asking the wrong
    // machine. The environment answers it either way.
    const settings = engineSettings(home === undefined ? {} : loadConfig(home), process.env);
    const credentials =
      settings.provider === 'claude' ? await verifyCredentials() : await verifyEngine(settings);
    if (credentials.ok) {
      console.log(`Ready, using ${credentials.how}.`);
      return 0;
    }
    console.error(`Not set up: ${credentials.why}.\n\n${credentials.fix}`);
    return 1;
  }
  if (home === undefined) {
    console.error(
      `No workbench here. Run "wb init" in the repository you want one for.\n\n` +
        `Looked for ${CONFIG_FILE} in this directory and in .workbench/, and in every\n` +
        `directory above. WB_HOME overrides the search.`,
    );
    return 1;
  }

  const config = loadConfig(home);
  if (command === 'serve') return serve(config);
  if (command === 'update') return update(config);

  const wb = createClient(`http://127.0.0.1:${config.port}`);

  switch (command) {
    case 'new': {
      const { rest, takeFlag, takeValue } = options(args);
      const noGate = takeFlag('--no-approval');
      const from = takeValue('--from');
      const after = takeValue('--after');
      const [title, body = ''] = rest;

      const unknown = rest.find((arg) => arg.startsWith('--'));
      if (unknown !== undefined) return fail(`unknown option ${unknown}`);
      if (args.includes('--from') && from === undefined) return fail('carry on from which ticket?');
      if (args.includes('--after') && after === undefined)
        return fail('start after which tickets?');
      if (!title) return fail('a ticket needs a title');

      const ticket = await wb.create(title, body, {
        from,
        ...(noGate ? { requiresApproval: false } : {}),
        ...(after === undefined ? {} : { waitsFor: after.split(',').map((o) => o.trim()) }),
      });
      console.log(`${ticket.id}  ${ticket.title}`);
      if (from !== undefined) console.log(`starting from ${from}'s work, on ${ticket.branch}`);
      if (noGate) console.log('it will build its own plan without stopping to be approved');
      if (ticket.waitsFor.length > 0) {
        console.log(
          `it starts after ${ticket.waitsFor.join(', ')} have offered their work or ended`,
        );
      }
      console.log(`in the backlog — nothing starts until: wb queue ${ticket.id}`);
      return 0;
    }

    case 'list': {
      const tickets = await wb.tickets();
      if (tickets.length === 0) {
        console.log('No tickets. Add one with: wb new "<title>"');
        return 0;
      }
      for (const t of tickets) {
        const held = heldBy(t, tickets);
        const waiting =
          held.length === 0 ? '' : `  (waits for ${held.map((h) => h.id).join(', ')})`;
        console.log(`${t.id.padEnd(6)} ${label(t)}  ${t.title}${waiting}`);
      }
      return 0;
    }

    case 'edit': {
      const { rest, takeFlag } = options(args);
      const noGate = takeFlag('--no-approval');
      const gate = takeFlag('--approval');
      const [id, title, body] = rest;

      const unknown = rest.find((arg) => arg.startsWith('--'));
      if (unknown !== undefined) return fail(`unknown option ${unknown}`);
      if (!id) return fail('which ticket?');
      if (noGate && gate) return fail('--approval or --no-approval, not both');
      // The gate can be said on its own; the words only with a title, because a
      // ticket needs one.
      if (!title && !noGate && !gate) return fail('a ticket needs a title');

      // Omitting the instructions leaves them alone rather than wiping them: losing
      // what you wrote by forgetting an argument is not a thing this should do. The
      // same for everything else unsaid.
      const ticket = await wb.edit(id, {
        ...(title ? { title } : {}),
        ...(body === undefined ? {} : { body }),
        ...(noGate ? { requiresApproval: false } : gate ? { requiresApproval: true } : {}),
      });
      console.log(`${ticket.id}  ${ticket.title}`);
      if (noGate) console.log('it will build its own plan without stopping to be approved');
      if (gate) console.log('its plan will stop to be approved');
      return 0;
    }

    case 'queue': {
      if (!args[0]) return fail('which ticket?');
      await wb.queue(args[0]);
      console.log(`${args[0]} queued`);
      return 0;
    }

    case 'backlog': {
      if (!args[0]) return fail('which ticket?');
      await wb.backlog(args[0]);
      console.log(`${args[0]} back in the backlog`);
      return 0;
    }

    case 'move': {
      const [id, before] = args;
      if (!id) return fail('which ticket?');
      const order = await wb.move(id, before ?? null);
      console.log(order.map((t) => `${t.id.padEnd(6)} ${t.title}`).join('\n'));
      return 0;
    }

    case 'wait': {
      const [id, others] = args;
      if (!id) return fail('which ticket?');
      if (!others) return fail('wait for which tickets? "none" takes them off again');
      const ticket = await wb.wait(
        id,
        others === 'none' ? [] : others.split(',').map((o) => o.trim()),
      );
      console.log(
        ticket.waitsFor.length === 0
          ? `${id} waits for nothing`
          : `${id} waits for ${ticket.waitsFor.join(', ')} — it starts once they have all ` +
              'offered their work or ended',
      );
      return 0;
    }

    case 'show':
      return show(wb, config, args[0]);

    case 'approve': {
      if (!args[0]) return fail('which ticket?');
      await wb.approve(args[0]);
      console.log(`${args[0]} approved`);
      return 0;
    }

    case 'reject': {
      const [id, reason] = args;
      if (!id) return fail('which ticket?');
      if (!reason) return fail('say why, so the next plan knows');
      await wb.reject(id, reason);
      console.log(`${id} sent back`);
      return 0;
    }

    case 'changes': {
      const [id, changes] = args;
      if (!id) return fail('which ticket?');
      if (!changes) return fail('say what to put right');
      await wb.changes(id, changes);
      console.log(`${id} back to implement, keeping its work`);
      return 0;
    }

    case 'answer': {
      const [id, answer] = args;
      if (!id) return fail('which ticket?');
      if (!answer) return fail('an answer is needed');
      await wb.answer(id, answer);
      console.log(`${id} answered`);
      return 0;
    }

    case 'ship': {
      if (!args[0]) return fail('which ticket?');
      await wb.ship(args[0]);
      console.log(`${args[0]} offered as a pull request`);
      return 0;
    }

    case 'merge': {
      if (!args[0]) return fail('which ticket?');
      await wb.merge(args[0]);
      console.log(`${args[0]} will be merged onto the base`);
      return 0;
    }

    case 'restart': {
      if (!args[0]) return fail('which ticket?');
      await wb.restart(args[0]);
      console.log(`${args[0]} restarted`);
      return 0;
    }

    case 'continue': {
      if (!args[0]) return fail('which ticket?');
      // Said here as well as by the server, so the person is told which of the two
      // moves they wanted rather than watching this one quietly do nothing.
      const { ticket: t } = await wb.ticket(args[0]);
      if (!t.interrupted) {
        return fail(
          t.question
            ? `${t.id} is waiting on an answer, not on being picked up — "wb answer ${t.id}" instead`
            : `${t.id} was not stopped mid-stage — there is no run to carry on, so "wb restart ${t.id}"`,
        );
      }
      await wb.carryOn(args[0]);
      console.log(`${args[0]} carrying on from where it stopped`);
      return 0;
    }

    case 'cancel': {
      const [id, reason] = args;
      if (!id) return fail('which ticket?');
      await wb.cancel(id, reason ?? '');
      console.log(`${id} cancelled`);
      return 0;
    }

    case 'stop': {
      // The tickets first, because what comes back from stopping is ids, and what
      // is worth reading about a stage in flight is its stage and what it has cost.
      const before = await wb.tickets();
      const { running, interrupted } = await wb.stop();
      const named = (ids: string[]) => before.filter((t) => ids.includes(t.id));

      // The same two things `wb serve` says on the way out, because they are the
      // same two moments: the polite stop that waits, and the one that does not.
      console.log(
        interrupted.length > 0
          ? abandoning(named(interrupted))
          : draining(named(running), 'wb stop'),
      );
      console.log('\nnothing new will start until: wb start');
      return 0;
    }

    case 'start': {
      await wb.start();
      console.log('started — whatever is queued goes now');
      return 0;
    }

    case 'wip': {
      const n = Number(args[0]);
      if (!Number.isInteger(n)) return fail('how many tickets at once?');
      const policy = await wb.setPolicy({ wipLimit: n });
      console.log(`at most ${policy.wipLimit} ticket(s) will run at once`);
      return 0;
    }

    default:
      return fail(`no such command: ${command}`);
  }
}

/**
 * Starts a workbench in a repository: the one command that runs before there is
 * anything to configure.
 *
 * It writes only what a project has to own — where its branch is, what its checks
 * are, and the skills saying how work of a kind is done here. No agents: the four
 * that ship are used until a project puts its own `<stage>.md` alongside, and only
 * that stage is then the project's to keep up to date. Scaffolding all four would
 * fork all four, for a change nobody made.
 */
async function init(where: string | undefined): Promise<number> {
  const target = path.resolve(where ?? process.cwd());

  // A workbench runs tickets in git worktrees cut from this repository. Started
  // anywhere else it would install cleanly and then fail on the first ticket.
  if (!fs.existsSync(path.join(target, '.git'))) {
    console.error(`${target} is not a git repository. Run this at the root of one.`);
    return 1;
  }

  // Every ticket lands as a merge commit, so a repository that forbids them is one
  // where no ticket can ever be accepted. Better said now than at the first merge.
  const refusal = await mergeCommitsRefusal(target);
  if (refusal !== undefined) {
    console.error(refusal);
    return 1;
  }

  const existing = findHome(target);
  if (existing !== undefined) {
    console.error(`There is already a workbench for this repository, in ${existing}.`);
    return 1;
  }

  const home = path.join(target, '.workbench');
  const write = (relative: string, body: string): void => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  write(
    CONFIG_FILE,
    `${JSON.stringify({ base: await currentBranch(target), checks: [] }, null, 2)}\n`,
  );

  // The database and the worktrees are this machine's, not the project's history.
  write('.gitignore', ['data/', '.worktrees/', '.env', '.env.*', ''].join('\n'));

  // Skills reach an agent as a local plugin, and a plugin is its manifest. Written
  // before any skill is, so both what ships and the first one anyone adds work.
  write(
    '.claude-plugin/plugin.json',
    `${JSON.stringify(
      {
        name: 'workbench',
        version: '0.0.0',
        description: "This repository's own skills, loaded into the agents the workbench runs.",
      },
      null,
      2,
    )}\n`,
  );
  // The skills that ship with the workbench, copied in rather than read from the
  // package, so they are this project's from the start: editing one on the board
  // changes how work is done here and nowhere else.
  fs.cpSync(path.join(PACKAGE_ROOT, 'skills'), path.join(home, 'skills'), { recursive: true });

  const shown = path.relative(target, home) || home;
  console.log(
    [
      `Workbench started in ${shown}/`,
      '',
      `  ${CONFIG_FILE.padEnd(22)}the branch to work from, and the checks every ticket must pass`,
      `  ${'skills/'.padEnd(22)}how work of a kind is done here — naming-a-ticket, and yours`,
      '',
      'Next:',
      '  wb auth               prove the workbench can reach the model service',
      '  wb serve              run the board',
      '',
      `The four agents come from ${path.join(PACKAGE_ROOT, 'agents')}.`,
      `Copy one into ${shown}/agents/ to change how that stage works; the rest keep`,
      'coming from the workbench.',
    ].join('\n'),
  );
  return 0;
}

/**
 * The branch this repository is on, which is the one new work should start from.
 *
 * Asked rather than assumed. Writing `main` into a repository whose branch is
 * `master` produces a workbench that installs cleanly and then blocks the first
 * ticket on `git rev-parse main` — which is how this was found.
 *
 * `symbolic-ref` rather than `rev-parse`, because it answers before the first commit,
 * which is exactly when someone is most likely to be setting this up.
 */
async function currentBranch(repo: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repo,
    });
    return stdout.trim() || 'main';
  } catch {
    return 'main';
  }
}

async function show(wb: Client, config: Config, id: string | undefined): Promise<number> {
  if (!id) return fail('which ticket?');
  const { ticket: t, events } = await wb.ticket(id);

  console.log(`${t.id}  ${t.title}`);
  if (t.body) console.log(t.body);
  console.log(`\nstatus   ${label(t).trim()}`);
  // A ticket the workbench was stopped in the middle of parks in the same place as
  // one that broke, and is not the same thing: there is a run underneath it worth
  // carrying on, and reading it as a failure is what made restarting expensive.
  if (t.interrupted) {
    console.log(
      `         stopped mid-stage, not failed — "wb continue ${t.id}" carries it on,\n` +
        `         "wb restart ${t.id}" runs the stage again from the top`,
    );
  }
  if (t.waitsFor.length > 0) {
    console.log(`waits    ${t.waitsFor.join(', ')}, until each offers its work or ends`);
  }
  console.log(`branch   ${t.branch}`);
  // Only when it is not the default: otherwise every ticket carries a line saying
  // it does the ordinary thing.
  if (!t.requiresApproval) console.log(`gate     none — it builds its plan unapproved`);
  if (t.base) console.log(`base     ${t.base.slice(0, 8)}`);
  if (t.commits.length > 0)
    console.log(`commits  ${t.commits.map((c) => c.slice(0, 8)).join(' ')}`);
  if (t.prUrl) console.log(`pr       ${t.prUrl}`);
  const stale = await unpushedBase(config);
  if (stale) console.log(stale);
  if (t.rejection) console.log(`sent back  ${t.rejection}`);
  if (t.question) console.log(`\nwaiting on you:\n  ${t.question.question}`);
  if (t.plan) console.log(`\n--- plan (${t.scale}) ---\n${t.plan}`);

  console.log(`\n--- history ---`);
  for (const e of events) console.log(`${e.at}  ${e.type}${describe(e)}`);
  return 0;
}

/**
 * Fetches whatever the project's dependency resolves to now.
 *
 * There is nothing to release: a project depends on the repository, npm writes down
 * the commit it resolved that to, and that commit is the version. So this predicts
 * nothing. It asks for the same dependency again and reads the lock file afterwards,
 * which is the one account of what actually changed — and which works the same for a
 * branch, a tag, a commit, or a semver range over tags, none of which this then has
 * to know anything about.
 *
 * It does not restart the workbench. A running one is holding tickets mid-stage, and
 * which moment to interrupt them is not this command's to pick.
 */
async function update(config: Config): Promise<number> {
  const here = installed(config);
  if (here === undefined) {
    console.error(
      'this workbench is not an installed copy, so there is nothing for npm to fetch.\n' +
        'Running from a checkout? Then the checkout is what to update.',
    );
    return 1;
  }

  console.log(`asking npm for ${here.name}@${here.spec}...`);
  try {
    await install(config, here);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const now = commitIn(config.repoRoot, here.key);
  if (now === undefined) {
    console.error(`installed, but the lock file no longer says what ${here.name} resolved to.`);
    return 1;
  }
  if (now === here.commit) {
    console.log(`already on the newest workbench (${short(now)}).`);
    return 0;
  }

  console.log(`\n${short(here.commit)} → ${short(now)}`);
  const changes = compareUrl(here.url, here.commit, now);
  if (changes !== undefined) console.log(changes);
  console.log('\nRestart "wb serve" to run it.');
  return 0;
}

/**
 * Whether something newer has been pushed, and — when there is someone to ask — an
 * offer to take it before this workbench starts.
 *
 * The workbench is what the agents run under, and code that governs them arriving
 * without anyone asking is the thing the whole design is against. So nothing here
 * installs anything on its own: with no terminal to answer, this is the notice it
 * always was. Anything that goes wrong — offline, no such remote, taking too long,
 * or a dependency whose ref cannot be worked out — means saying nothing: a workbench
 * that will not start because it could not check for an update would be a worse tool
 * than one that is out of date.
 *
 * A pinned dependency is therefore silent by construction rather than by rule. Nothing
 * here knows what pinning is: it asks what the spec's own ref points at, and a tag
 * points where it always did.
 *
 * Taking the offer ends this process's part in serving: `npm install` replaces the
 * code on disk, but the old build is what is running, so the new one only serves if a
 * new process runs it. A number back means `serve` is finished — either the child has
 * exited and its code is ours, or the install failed and nothing started.
 */
async function offerUpdate(config: Config): Promise<number | undefined> {
  const here = installed(config);
  // A child was started by the offer below, and must not offer again: a spec whose ref
  // npm does not resolve to still looks out of date the moment it starts, and would
  // relaunch itself forever.
  if (here === undefined || process.env[CHILD_ENV] !== undefined) return undefined;

  let latest: string | undefined;
  try {
    latest = await newest(here.url, here.spec);
  } catch {
    return undefined;
  }
  if (latest === undefined || latest === here.commit) return undefined;

  if (!process.stdin.isTTY) {
    console.log(
      `⬆️  an update is waiting: ${short(here.commit)} → ${short(latest)}.\n` +
        '    Run "wb update", then start again.\n',
    );
    return undefined;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let yes = false;
  try {
    yes = taken(await rl.question(offer(short(here.commit), short(latest))));
  } catch {
    // Ctrl-C or Ctrl-D at the question. Nothing was answered, so nothing is installed —
    // the same as saying no, and said the same way.
  } finally {
    rl.close();
  }
  if (!yes) return undefined;

  console.log(`\nasking npm for ${here.name}@${here.spec}...`);
  try {
    await install(config, here);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const now = commitIn(config.repoRoot, here.key);
  if (now !== undefined) {
    console.log(`\n${short(here.commit)} → ${short(now)}`);
    const changes = compareUrl(here.url, here.commit, now);
    if (changes !== undefined) console.log(changes);
  }

  return await handOver();
}

/**
 * Runs `wb serve` again from the code npm has just installed, and waits for it.
 *
 * The child inherits this terminal, so what it prints is what someone sees and what
 * they type reaches it — from here on this process is only holding the exit code. It
 * also inherits Ctrl-C, which the terminal delivers to the whole group: the child
 * drains its stages and says what that costs, and this one must stay out of the way
 * until it has, or the terminal comes back while the child is still writing to it.
 */
async function handOver(): Promise<number> {
  const { command, args } = relaunch(process.execPath, process.argv);
  console.log('\nstarting the new workbench...\n');

  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, [CHILD_ENV]: '1' },
  });

  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});

  return await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      console.error(`the new workbench would not start: ${error.message}`);
      resolve(1);
    });
    // A child killed by a signal has no code of its own, and reporting it as 0 would
    // say it finished cleanly.
    child.on('exit', (code, signal) => resolve(signal === null ? (code ?? 1) : 1));
  });
}

/**
 * The port to serve on, having found out who is on the configured one.
 *
 * A workbench per repository is how this is meant to be run, and the only thing in
 * the way is that they all default to the same port. A second one for the *same*
 * repository is a different matter: it would open the same database as the first
 * and the two would disagree about it, so that is refused rather than moved.
 *
 * Moving is offered rather than assumed, and written down when taken. The port is
 * how every other `wb` command finds the board, so one that moved quietly is one
 * every command in the other terminal is now wrong about.
 */
async function choosePort(config: Config): Promise<number | undefined> {
  const occupant = await occupantOf(config.port);
  if (occupant.kind === 'free') return config.port;

  if (occupant.kind === 'workbench' && occupant.home === config.home) {
    console.error(
      `a workbench for this repository is already running on port ${config.port}.\n` +
        'Use it, or stop it first — every other command talks to it over HTTP.',
    );
    return undefined;
  }

  const whose =
    occupant.kind === 'workbench' ? `the workbench in ${occupant.home}` : 'something else';
  const free = await nextFree(config.port + 1);
  if (free === undefined) {
    console.error(`port ${config.port} is taken by ${whose}, and so is every port after it.`);
    return undefined;
  }

  if (!process.stdin.isTTY) {
    console.error(
      `port ${config.port} is taken by ${whose}.\n` +
        `Set "port" in ${CONFIG_FILE} — ${free} is free — or stop what is there.`,
    );
    return undefined;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let yes = false;
  try {
    const answer = await rl.question(
      `Port ${config.port} is taken by ${whose}.\n` +
        `Start this workbench on ${free}, and write that to ${CONFIG_FILE}? [Y/n] `,
    );
    yes = ['', 'y', 'yes'].includes(answer.trim().toLowerCase());
  } catch {
    // Ctrl-C or Ctrl-D at the question. Nothing was answered, so nothing moves —
    // the same as saying no, and said the same way.
  } finally {
    rl.close();
  }

  if (!yes) {
    console.error(`nothing started. Set "port" in ${CONFIG_FILE} to choose one yourself.`);
    return undefined;
  }

  writeConfigFile(config, { port: free });
  console.log(`port ${free} written to ${CONFIG_FILE}\n`);
  return free;
}

/** Runs the workbench in this process, and says what it is doing as it goes. */
async function serve(config: Config): Promise<number> {
  // First of all, before a port is taken, the database opened or an orchestrator
  // started: taking the update hands the terminal to a new process, and nothing of
  // this one's may still be open when it does.
  const handed = await offerUpdate(config);
  if (handed !== undefined) return handed;

  // Asked again here, not only at `wb init`: the setting can be turned off after a
  // workbench is running, and every merge from then on would be refused.
  const refusal = await mergeCommitsRefusal(config.repoRoot);
  if (refusal !== undefined) {
    console.error(refusal);
    return 1;
  }

  const port = await choosePort(config);
  if (port === undefined) return 1;
  const running = port === config.port ? config : { ...config, port };

  const wb = await startWorkbench(running, (message) => console.log(`\n${message}\n`));

  for (const id of reconcile(wb.store)) {
    console.log(`${id}  stopped mid-stage; "wb continue ${id}" carries it on from there`);
  }

  // Only the good news: the orchestrator announces the bad news itself, on its first
  // tick and on every change after it, and saying it twice reads like two problems.
  if (config.runner !== 'fake') {
    const credentials = await checkCredentials();
    if (credentials.ok) console.log(`credentials: ${credentials.how}\n`);
  }

  if (!fs.existsSync(UI_DIST)) {
    console.warn('⚠️  the board is not built: run "npm run build". Everything else works.\n');
  }

  if (config.checks.length === 0) {
    console.warn(
      '⚠️  no checks configured: verify can only report that it could not break something,\n' +
        '    not that anything passes. Set "checks" in workbench.config.json.\n',
    );
  }

  wb.store.subscribe((e) => console.log(`${e.ticketId}  ${e.type}${describe(e)}`));
  wb.orchestrator.start();
  const how = config.runner === 'fake' ? 'fake agents, nothing is charged' : 'real agents';
  console.log(`workbench on http://127.0.0.1:${wb.port}  (${how})  —  Ctrl-C to stop\n`);

  // Being stopped outlives the process that was stopped, which is the point of it —
  // it is how you update the workbench without it starting work underneath you. A
  // board that then sits silent has to say why rather than look broken.
  if (wb.store.stopped()) {
    console.warn('⚠️  the workbench is stopped: nothing will start until "wb start".\n');
  }

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

  // Asked before the drain rather than during it: by the time closing returns there
  // is nothing left running to name, and the names are the point.
  const inFlight = wb.store.tickets().filter((t) => t.running);
  console.log(`\n${draining(inFlight)}\n`);

  // The second interrupt is the impatient one, and the expensive one. Node's default
  // would take it — the first listener removed itself by firing — and kill the process
  // without a word. It still stops immediately; it just says what that costs.
  //
  // Every stage that finishes while draining still prints, because the line that
  // reports events is subscribed until the store closes. So the list above empties
  // itself in front of whoever is waiting, which is what makes waiting bearable.
  process.on('SIGINT', () => {
    console.log(`\n${abandoning(wb.store.tickets().filter((t) => t.running))}`);
    process.exit(1);
  });

  await wb.close();
  return 0;
}

/**
 * Warns when the manager's own base branch holds commits the remote does not, and
 * which are therefore in no ticket. A ticket branches from the base as the remote
 * has it, so work sitting only on this machine is invisible to it — worth knowing
 * before approving a plan written against code you may be looking at and it is not.
 */
async function unpushedBase(config: Config): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['rev-list', '--count', `origin/${config.base}..${config.base}`],
      { cwd: config.repoRoot },
    );
    const ahead = stdout.trim();
    if (ahead === '0') return undefined;
    return (
      `⚠️  your local ${config.base} is ${ahead} commit(s) ahead of the remote,\n` +
      `    and none of them are in this ticket.`
    );
  } catch {
    return undefined;
  }
}

/**
 * Flags first, in any order, and what is left is positional. Reading `--from` by
 * position alone worked until there were two flags.
 */
function options(args: readonly string[]) {
  const rest = [...args];
  const takeFlag = (name: string): boolean => {
    const at = rest.indexOf(name);
    if (at === -1) return false;
    rest.splice(at, 1);
    return true;
  };
  const takeValue = (name: string): string | undefined => {
    const at = rest.indexOf(name);
    return at === -1 ? undefined : rest.splice(at, 2)[1];
  };
  return { rest, takeFlag, takeValue };
}

function fail(message: string): number {
  console.error(`${message}\n\n${USAGE}`);
  return 1;
}

function label(t: Ticket): string {
  return (t.running ? `${t.status}*` : t.status).padEnd(17);
}

function describe(e: { type: string } & Record<string, unknown>): string {
  if (e.type === 'stage_started') return `  ${String(e['stage'])}`;
  if (e.type === 'stage_finished') return `  ${String(e['outcome'])}`;
  if (e.type === 'tool_requested') {
    return `  ${String(e['tool'])}${e['allowed'] === false ? ' — REFUSED' : ''}`;
  }
  if (e.type === 'checks_run') {
    const results = Array.isArray(e['results']) ? (e['results'] as { ok?: unknown }[]) : [];
    const failed = results.filter((r) => r.ok === false).length;
    return `  ${results.length} check(s), ${failed === 0 ? 'all passed' : `${failed} FAILED`}`;
  }
  if (e.type === 'question_asked') return `  ${String(e['question'])}`;
  if (e.type === 'blocked') return `  ${String(e['reason'])}`;
  if (e.type === 'pr_opened') return `  ${String(e['url'])}`;
  if (e.type === 'refreshed') return `  merged the base at ${String(e['base']).slice(0, 8)}`;
  return '';
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
