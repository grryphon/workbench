import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  abandonMerge,
  branchOnRemote,
  commitAll,
  create,
  diff,
  inHistoryOf,
  isBranchName,
  push,
  refresh,
  remove,
  removedFromBase,
  unresolved,
  type GitConfig,
} from './worktree.ts';
import { resolveOn } from '../github/pr.ts';
import { RemoteMoved } from '../orchestrator/describe.ts';

const run = promisify(execFile);

/**
 * A real throwaway repository, laid out as ours is: the project beside the
 * workbench's own source, one commit on main.
 */
async function scratchRepo(protectedPaths?: string[]): Promise<GitConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-git-'));
  const repoRoot = path.join(root, 'repo');
  await fs.mkdir(path.join(repoRoot, 'workbench', 'src'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'project'), { recursive: true });

  const git = (...args: string[]) => run('git', args, { cwd: repoRoot });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repoRoot, 'workbench', 'src', 'rules.ts'), 'the guardrails\n');
  await fs.writeFile(path.join(repoRoot, 'project', 'model.py'), 'the work\n');
  await fs.writeFile(path.join(repoRoot, 'package.json'), '{ "name": "the-project" }\n');
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'the project\n');
  await git('add', '-A');
  await git('commit', '-m', 'first');

  return { repoRoot, worktreeRoot: path.join(root, 'worktrees'), base: 'main', protectedPaths };
}

const cleanUp = (cfg: GitConfig) =>
  fs.rm(path.dirname(cfg.repoRoot), { recursive: true, force: true });

async function present(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test('a ticket gets its own branch and directory', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');

    assert.equal(wt.branch, 'wb/t1');
    assert.ok(wt.path.endsWith(path.join('worktrees', 't1')));
    assert.ok(await present(path.join(wt.path, 'project', 'model.py')), 'the base is checked out');
  } finally {
    await cleanUp(cfg);
  }
});

test('two tickets do not collide', async () => {
  const cfg = await scratchRepo();
  try {
    const one = await create(cfg, 't1');
    const two = await create(cfg, 't2');

    await fs.writeFile(path.join(one.path, 'a.txt'), 'from t1\n');
    await fs.writeFile(path.join(two.path, 'b.txt'), 'from t2\n');
    await commitAll(one, 'work on t1');
    await commitAll(two, 'work on t2');

    assert.match(await diff(cfg, one), /a\.txt[\s\S]*from t1/);
    assert.doesNotMatch(await diff(cfg, one), /b\.txt/);
    assert.match(await diff(cfg, two), /b\.txt[\s\S]*from t2/);
  } finally {
    await cleanUp(cfg);
  }
});

test('create is idempotent, so a restart mid-ticket resumes', async () => {
  const cfg = await scratchRepo();
  try {
    const first = await create(cfg, 't1');
    await fs.writeFile(path.join(first.path, 'work.txt'), 'in progress\n');

    const second = await create(cfg, 't1');

    assert.equal(second.path, first.path);
    assert.equal(second.branch, first.branch);
    assert.equal(second.base, null, 'only the call that cut the branch reports a base');
    assert.equal(await fs.readFile(path.join(second.path, 'work.txt'), 'utf8'), 'in progress\n');
  } finally {
    await cleanUp(cfg);
  }
});

test('committing reports whether there was anything to commit', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    assert.equal(await commitAll(wt, 'nothing yet'), null, 'nothing to commit');

    await fs.writeFile(path.join(wt.path, 'a.txt'), 'hello\n');
    assert.match((await commitAll(wt, 'add a')) ?? '', /^[0-9a-f]{40}$/, 'the sha is the record');
    assert.match(await diff(cfg, wt), /\+hello/);
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket gets a scratch directory beside its worktree, not inside it', async () => {
  // t4 wrote a probe into the worktree because it had nowhere else, and it survived
  // only because verify remembered to delete it. Scratch is outside the worktree, so
  // nothing left in it can reach a commit however forgetful the agent was.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    assert.equal(await present(wt.scratch), true, 'it exists before any stage runs');
    assert.equal(path.dirname(wt.scratch), path.dirname(wt.path), 'beside the worktree');
    assert.equal(await present(path.join(wt.path, path.basename(wt.scratch))), false, 'not in it');

    await fs.writeFile(path.join(wt.scratch, 'probe.py'), 'assert False\n');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, improved\n');
    await commitAll(wt, 'improve the model');

    const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: wt.path });
    assert.doesNotMatch(stdout, /probe\.py/, 'the probe cannot reach the commit');

    const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: wt.path });
    assert.equal(dirty.trim(), '', 'and it does not even show as untracked');
  } finally {
    await cleanUp(cfg);
  }
});

test('the scratch directory survives a restart mid-ticket, and goes when the worktree does', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.scratch, 'notes.txt'), 'working it out\n');

    await create(cfg, 't1'); // the worktree already exists; scratch must still be there
    assert.equal(await present(path.join(wt.scratch, 'notes.txt')), true);

    await remove(cfg, 't1');
    assert.equal(await present(wt.scratch), false, 'tidied up with the worktree');
  } finally {
    await cleanUp(cfg);
  }
});

test('removing a worktree leaves the branch, which may be in a pull request', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'hello\n');
    await commitAll(wt, 'add a');

    await remove(cfg, 't1');
    await assert.rejects(() => fs.stat(wt.path), 'the directory is gone');

    const { stdout } = await run('git', ['branch', '--list', 'wb/t1'], { cwd: cfg.repoRoot });
    assert.match(stdout, /wb\/t1/, 'the branch survives');

    await remove(cfg, 't1'); // removing again is not an error
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket branches from the remote, not from a stale local base', async () => {
  // The bug this exists for: a pull request merged on the code host leaves local
  // main behind, and a ticket branched from it works against code that no longer
  // exists. The first live one asked why the files it was told to delete were not
  // there — and it was right.
  const cfg = await scratchRepo();
  try {
    const remote = path.join(path.dirname(cfg.repoRoot), 'remote.git');
    await run('git', ['init', '--bare', '-b', 'main', remote]);
    await run('git', ['remote', 'add', 'origin', remote], { cwd: cfg.repoRoot });
    await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: cfg.repoRoot });

    // Someone merges something. It reaches the remote; this checkout knows nothing.
    const elsewhere = path.join(path.dirname(cfg.repoRoot), 'elsewhere');
    await run('git', ['clone', '-q', remote, elsewhere]);
    await run('git', ['config', 'user.email', 'other@example.com'], { cwd: elsewhere });
    await run('git', ['config', 'user.name', 'Other'], { cwd: elsewhere });
    await fs.writeFile(path.join(elsewhere, 'merged.txt'), 'from the remote\n');
    await run('git', ['add', '-A'], { cwd: elsewhere });
    await run('git', ['commit', '-q', '-m', 'merged elsewhere'], { cwd: elsewhere });
    await run('git', ['push', '-q'], { cwd: elsewhere });

    const wt = await create(cfg, 't1');

    assert.equal(
      await fs.readFile(path.join(wt.path, 'merged.txt'), 'utf8'),
      'from the remote\n',
      'the ticket sees the merge, without anyone pulling',
    );
    const local = await run('git', ['log', '-1', '--format=%s', 'main'], { cwd: cfg.repoRoot });
    assert.equal(local.stdout.trim(), 'first', "and the manager's own main was left alone");
  } finally {
    await cleanUp(cfg);
  }
});

/**
 * A remote with a branch on it that somebody else owns, and a clone of theirs to move
 * it — or main — from, the way their pushes would.
 */
async function theirBranch(cfg: GitConfig) {
  const remote = path.join(path.dirname(cfg.repoRoot), 'remote.git');
  await run('git', ['init', '--bare', '-b', 'main', remote]);
  await run('git', ['remote', 'add', 'origin', remote], { cwd: cfg.repoRoot });
  await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: cfg.repoRoot });

  const elsewhere = path.join(path.dirname(cfg.repoRoot), 'elsewhere');
  await run('git', ['clone', '-q', remote, elsewhere]);
  const theirs = (...args: string[]) => run('git', args, { cwd: elsewhere });
  await theirs('config', 'user.email', 'other@example.com');
  await theirs('config', 'user.name', 'Other');

  /** Commits a file to `branch` over there and pushes it, cutting the branch from main if new. */
  const push = async (branch: string, file: string) => {
    await theirs('fetch', '-q', 'origin');
    const known = await theirs('ls-remote', '--heads', 'origin', branch);
    await theirs(
      'checkout',
      '-q',
      '-B',
      branch,
      known.stdout.trim() ? `origin/${branch}` : 'origin/main',
    );
    await fs.writeFile(path.join(elsewhere, file), `${file} from them\n`);
    await theirs('add', '-A');
    await theirs('commit', '-q', '-m', `${file} on ${branch}`);
    await theirs('push', '-q', 'origin', branch);
    return (await theirs('rev-parse', 'HEAD')).stdout.trim();
  };
  const remoteHead = async (branch: string) =>
    (await run('git', ['rev-parse', branch], { cwd: remote })).stdout.trim();

  return { push, remoteHead, git: theirs };
}

test('a branch to work on is one the remote has', async () => {
  const cfg = await scratchRepo();
  try {
    const them = await theirBranch(cfg);
    await them.push('their-feature', 'theirs.txt');

    assert.equal(await branchOnRemote(cfg, 'their-feature'), true);
    assert.equal(await branchOnRemote(cfg, 'no-such'), false);

    // A name that git would take as an option runs nothing, whichever way it arrives.
    const pwned = path.join(path.dirname(cfg.repoRoot), 'PWNED');
    const evil = `--upload-pack=touch ${pwned};git-upload-pack`;
    assert.equal(await isBranchName(evil), false);
    assert.equal(await isBranchName('-x'), false);
    assert.equal(await isBranchName('feature/ok'), true);
    assert.deepEqual(await resolveOn(cfg, evil), { error: `${evil} is not a branch name` });
    assert.equal(await branchOnRemote(cfg, evil), false);
    await assert.rejects(() => inHistoryOf(cfg, 'HEAD', evil));
    await create(cfg, 't9', undefined, evil).catch(() => {});
    assert.equal(await present(pwned), false, 'no fetch ran it as a command');
  } finally {
    await cleanUp(cfg);
  }
});

test('pushed work merged into main is in its history, and squashed onto it is not', async () => {
  const cfg = await scratchRepo();
  try {
    const them = await theirBranch(cfg);
    const merged = await them.push('their-feature', 'theirs.txt');
    const squashed = await them.push('other-feature', 'other.txt');
    // Here as well, as a commit the workbench pushed from a worktree would be.
    await run('git', ['fetch', '-q', 'origin'], { cwd: cfg.repoRoot });

    await them.git('checkout', '-q', '-B', 'main', 'origin/main');
    await them.git('merge', '-q', '--no-ff', '-m', 'merge their-feature', 'origin/their-feature');
    await them.git('merge', '-q', '--squash', 'origin/other-feature');
    await them.git('commit', '-q', '-m', 'other-feature, squashed');
    await them.git('push', '-q', 'origin', 'main');

    assert.equal(await inHistoryOf(cfg, merged, 'main'), true, 'a merge commit keeps it');
    assert.equal(await inHistoryOf(cfg, squashed, 'main'), false, 'a squash does not');
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket on somebody else’s branch is cut from it and kept current with it', async () => {
  const cfg = await scratchRepo();
  try {
    const them = await theirBranch(cfg);
    const tip = await them.push('their-feature', 'theirs.txt');

    const wt = await create(cfg, 't1', undefined, 'their-feature');
    assert.equal(wt.base, tip, 'measured from their branch as the remote has it');
    assert.equal(await present(path.join(wt.path, 'theirs.txt')), true);

    // Both move. Only their branch is what this ticket stands on.
    await them.push('their-feature', 'more.txt');
    await them.push('main', 'main-only.txt');

    const result = await refresh(cfg, 't1', [], false, 'their-feature');
    assert.equal(result.kind, 'merged');
    assert.equal(await present(path.join(wt.path, 'more.txt')), true, 'their new work came in');
    assert.equal(await present(path.join(wt.path, 'main-only.txt')), false, 'and main did not');
  } finally {
    await cleanUp(cfg);
  }
});

test('a branch it does not own is taken from the remote or not at all', async () => {
  const cfg = await scratchRepo();
  try {
    const them = await theirBranch(cfg);
    await them.push('their-feature', 'theirs.txt');
    const wt = await create(cfg, 't1', undefined, 'their-feature');
    const cut = (await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path })).stdout.trim();

    // A local branch of the same name, carrying a commit nobody else has, and a remote
    // that cannot be reached to say so.
    const here = (...args: string[]) => run('git', args, { cwd: cfg.repoRoot });
    await fs.writeFile(path.join(cfg.repoRoot, 'local-only.txt'), 'never pushed\n');
    await here('add', '-A');
    await here('commit', '-q', '-m', 'local only');
    const local = (await here('rev-parse', 'HEAD')).stdout.trim();
    await here('update-ref', 'refs/heads/their-feature', local);
    await here('remote', 'set-url', 'origin', path.join(path.dirname(cfg.repoRoot), 'gone.git'));

    await assert.rejects(() => refresh(cfg, 't1', [], false, 'their-feature'));
    assert.equal(
      await present(path.join(wt.path, 'local-only.txt')),
      false,
      'nothing unpushed came in',
    );
    assert.equal(
      (await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path })).stdout.trim(),
      cut,
      'and the branch is where it was',
    );
    await assert.rejects(() => create(cfg, 't2', undefined, 'their-feature'), 'nor at cut time');

    // The base keeps its fallback: a repository with no reachable remote still works.
    assert.ok(await refresh(cfg, 't1'));
  } finally {
    await cleanUp(cfg);
  }
});

test('work on somebody else’s branch goes back to it as a fast-forward, or not at all', async () => {
  const cfg = await scratchRepo();
  try {
    const them = await theirBranch(cfg);
    await them.push('their-feature', 'theirs.txt');
    const wt = await create(cfg, 't1', undefined, 'their-feature');

    await fs.writeFile(path.join(wt.path, 'fix.txt'), 'the fix\n');
    const mine = await commitAll(wt, 'the fix');
    assert.equal(await push(cfg, 't1', 'their-feature'), mine);
    assert.equal(await them.remoteHead('their-feature'), mine, 'their branch has it');

    // They push again before the next one goes.
    const theirs = await them.push('their-feature', 'theirs-again.txt');
    await fs.writeFile(path.join(wt.path, 'fix.txt'), 'the fix, again\n');
    await commitAll(wt, 'more of the fix');
    await assert.rejects(() => push(cfg, 't1', 'their-feature'), RemoteMoved);
    assert.equal(
      await them.remoteHead('their-feature'),
      theirs,
      'nothing of theirs was overwritten',
    );

    // Taken in, it goes.
    assert.equal((await refresh(cfg, 't1', [], false, 'their-feature')).kind, 'merged');
    const merged = await push(cfg, 't1', 'their-feature');
    assert.equal(await them.remoteHead('their-feature'), merged);
  } finally {
    await cleanUp(cfg);
  }
});

test('nothing the workbench runs can force a push', async () => {
  // Read off the source rather than trusted to review: the one force in here is
  // `worktree remove`, which deletes a directory and pushes nothing.
  for (const file of ['./worktree.ts', '../github/pr.ts']) {
    const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    const lines = source.split('\n');
    for (const line of lines.filter((l) => /'(--force[\w-]*|-f)'/.test(l))) {
      assert.match(line, /'remove'/, `${file} forces something: ${line.trim()}`);
    }
    // And no refspec that starts with a `+`, which forces without saying so.
    for (const line of lines.filter((l) => /'push'/.test(l))) {
      assert.doesNotMatch(line, /['`]\+/, `${file} forces a push: ${line.trim()}`);
    }
  }
});

// The workbench and the project live in one repository, so a ticket's worktree
// would normally contain the guardrails the agent runs under. These are the three
// things that have to hold at once: absent from disk, present in the commit, and
// invisible to the diff.

test('without protection, an agent worktree contains the workbench', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    assert.equal(await present(path.join(wt.path, 'workbench', 'src', 'rules.ts')), true);
  } finally {
    await cleanUp(cfg);
  }
});

test('a protected path may be a file, not only a directory', async () => {
  // The repository root's `package.json` names the workbench version it installs, so
  // it decides which workbench governs the next ticket. A trailing slash in the
  // sparse-checkout pattern made every entry directory-only and left the file on disk.
  const cfg = await scratchRepo(['workbench', 'package.json']);
  try {
    const wt = await create(cfg, 't1');

    assert.equal(await present(path.join(wt.path, 'package.json')), false, 'the file is gone');
    assert.equal(
      await present(path.join(wt.path, 'README.md')),
      true,
      'and the root is not emptied along with it',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('protected directories are simply not in the worktree', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');

    assert.equal(
      await present(path.join(wt.path, 'workbench')),
      false,
      'the workbench is not on disk, so no tool can reach it',
    );
    assert.equal(
      await present(path.join(wt.path, 'project', 'model.py')),
      true,
      'the work itself is still there',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('committing from a protected worktree does not delete the workbench', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, improved\n');
    assert.match((await commitAll(wt, 'improve the model')) ?? '', /^[0-9a-f]{40}$/);

    // The critical check: the commit must still carry the files that were hidden.
    const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: wt.path,
    });
    const files = stdout.split('\n').filter((l) => l !== '');
    assert.ok(
      files.includes('workbench/src/rules.ts'),
      `the workbench must survive the commit, got: ${files.join(', ')}`,
    );
    assert.ok(files.includes('project/model.py'));

    const kept = await run('git', ['show', 'HEAD:workbench/src/rules.ts'], { cwd: wt.path });
    assert.equal(kept.stdout, 'the guardrails\n', 'and its contents must be unchanged');
  } finally {
    await cleanUp(cfg);
  }
});

test('the protected directory survives a diff against the base branch', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'changed\n');
    await commitAll(wt, 'change the model');

    const { stdout } = await run('git', ['diff', '--name-only', 'main...HEAD'], {
      cwd: wt.path,
    });
    assert.deepEqual(
      stdout.split('\n').filter((l) => l !== ''),
      ['project/model.py'],
      'only the work shows as changed',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket can carry on from another, with its work already in the worktree', async () => {
  const cfg = await scratchRepo();
  try {
    // t1 does some work and stops without ever being accepted. Its commit is on
    // its branch and nowhere else — which, before this, meant nowhere reachable.
    const first = await create(cfg, 't1');
    await fs.writeFile(path.join(first.path, 'project', 'draft.md'), '# a draft\n');
    const stranded = await commitAll(first, 'implement: a draft (t1)');
    assert.ok(stranded);

    const second = await create(cfg, 't2', 'wb/t1');

    const draft = await fs.readFile(path.join(second.path, 'project', 'draft.md'), 'utf8');
    assert.equal(draft, '# a draft\n', "t1's work is on disk in t2's own worktree");
    assert.equal(second.base, stranded, 't2 is cut from where t1 stopped');

    // And the new ticket's diff is its own work, not the work it inherited.
    await fs.writeFile(path.join(second.path, 'project', 'draft.md'), '# a better draft\n');
    await commitAll(second, 'implement: fix the draft (t2)');

    const own = await diff(cfg, second, second.base);
    assert.match(own, /a better draft/);
    assert.doesNotMatch(own, /new file/, 'the inherited draft is not presented as new work');

    // Against main it would be the whole thing — which is what a reviewer would
    // otherwise have been handed.
    assert.match(await diff(cfg, second), /new file/);
  } finally {
    await cleanUp(cfg);
  }
});

// What a stage is shown must be what this branch changed against everything it
// stood on. On three tickets in one project it was not: the base was held while a
// dependency was still offered, main moved and was merged in, and the reviewer read
// the files main had added as the ticket's own — asked for them to be untracked, and
// got it. These four are the cases that have to come out right.

test('main moving on and being merged in is not the ticket’s work', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'mine.py'), 'what t1 wrote\n');
    await commitAll(wt, 'implement: t1');

    await landOnBase(cfg, 'project/elsewhere.py', 'what another ticket landed\n');
    const refreshed = await refresh(cfg, 't1');
    assert.equal(refreshed.kind, 'merged');

    // Nothing carried, so the base advanced with the refresh.
    const shown = await diff(cfg, wt, refreshed.kind === 'merged' ? refreshed.base : null);
    assert.match(shown, /what t1 wrote/, "the ticket's own work is there");
    assert.doesNotMatch(shown, /elsewhere\.py/, "and main's advance is not");
  } finally {
    await cleanUp(cfg);
  }
});

test('a dependency that has since landed is nobody’s work but its own', async () => {
  const cfg = await scratchRepo();
  try {
    // t1 offers, t2 takes the work in before it lands, and does some of its own.
    await offeredWork(cfg, 't1', 'project/first.py', 'what t1 wrote\n');
    const wt = await create(cfg, 't2');
    await fs.writeFile(path.join(wt.path, 'project', 'mine.py'), 'what t2 wrote\n');
    await commitAll(wt, 'implement: t2');
    assert.equal((await refresh(cfg, 't2', ['wb/t1'])).kind, 'merged');

    // Then t1's pull request lands with a merge commit, and main moves on again.
    await run('git', ['merge', '--no-edit', 'wb/t1'], { cwd: cfg.repoRoot });
    await landOnBase(cfg, 'project/elsewhere.py', 'what another ticket landed\n');
    const after = await refresh(cfg, 't2', ['wb/t1']);
    assert.equal(after.kind, 'merged');

    // `carrying` stops naming a merge once its work has landed, so nothing holds
    // the base any more.
    const shown = await diff(cfg, wt, after.kind === 'merged' ? after.base : null, []);
    assert.match(shown, /what t2 wrote/, "the ticket's own work is there");
    assert.doesNotMatch(shown, /first\.py/, "the dependency's work is not");
    assert.doesNotMatch(shown, /elsewhere\.py/, "nor is main's advance");
  } finally {
    await cleanUp(cfg);
  }
});

test('a dependency still unlanded hides its own work without hiding main’s', async () => {
  // The case the held base cannot describe on its own: the branch is standing on a
  // commit of the dependency's that the base has not got, and on a base that has
  // moved since. No single commit is both, so one is synthesised.
  const cfg = await scratchRepo();
  try {
    await offeredWork(cfg, 't1', 'project/first.py', 'what t1 wrote\n');
    const wt = await create(cfg, 't2');
    await fs.writeFile(path.join(wt.path, 'project', 'mine.py'), 'what t2 wrote\n');
    await commitAll(wt, 'implement: t2');
    assert.equal((await refresh(cfg, 't2', ['wb/t1'])).kind, 'merged');

    // Main moves on and is merged in. t1 is still only offering, so the base is
    // held where it was cut.
    await landOnBase(cfg, 'project/elsewhere.py', 'what another ticket landed\n');
    assert.equal((await refresh(cfg, 't2', ['wb/t1'])).kind, 'merged');

    const shown = await diff(cfg, wt, wt.base, ['wb/t1']);
    assert.match(shown, /what t2 wrote/, "the ticket's own work is there");
    assert.doesNotMatch(shown, /first\.py/, "the dependency's work is not");
    assert.doesNotMatch(shown, /elsewhere\.py/, "nor is main's advance since the refresh");
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket continuing a cancelled one shows neither its work nor main’s', async () => {
  const cfg = await scratchRepo();
  try {
    // t1 was released without ever being accepted; t2 carries on from its branch.
    const first = await create(cfg, 't1');
    await fs.writeFile(path.join(first.path, 'project', 'draft.md'), '# a draft\n');
    await commitAll(first, 'implement: a draft (t1)');

    const wt = await create(cfg, 't2', 'wb/t1');
    await fs.writeFile(path.join(wt.path, 'project', 'mine.py'), 'what t2 wrote\n');
    await commitAll(wt, 'implement: t2');

    await landOnBase(cfg, 'project/elsewhere.py', 'what another ticket landed\n');
    assert.equal((await refresh(cfg, 't2')).kind, 'merged');

    // A continuation holds its base at the branch it was cut from for good, so the
    // base alone has none of main's advance in it.
    const shown = await diff(cfg, wt, wt.base);
    assert.match(shown, /what t2 wrote/, "the ticket's own work is there");
    assert.doesNotMatch(shown, /a draft/, "the cancelled ticket's work is not");
    assert.doesNotMatch(shown, /elsewhere\.py/, "nor is main's advance");
  } finally {
    await cleanUp(cfg);
  }
});

test('a carried branch that will not merge with the base falls back rather than throwing', async () => {
  const cfg = await scratchRepo();
  try {
    // t1 and main both change the same file, differently. t2 has taken in both and
    // settled the conflict on its own branch — so there is no clean merge of what it
    // stood on to be had, and the synthetic base cannot be built.
    await offeredWork(cfg, 't1', 'project/model.py', 'what t1 wrote\n');
    const wt = await create(cfg, 't2');
    await fs.writeFile(path.join(wt.path, 'project', 'mine.py'), 'what t2 wrote\n');
    await commitAll(wt, 'implement: t2');

    await landOnBase(cfg, 'project/model.py', 'what main landed\n');
    const stuck = await refresh(cfg, 't2', ['wb/t1'], true);
    assert.equal(stuck.kind, 'conflicted');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'settled between them\n');
    await commitAll(wt, 'implement: settle the conflict');

    const shown = await diff(cfg, wt, wt.base, ['wb/t1']);
    assert.match(shown, /what t2 wrote/, "the ticket's own work is there");
    const { stdout } = await run('git', ['diff', `${wt.base}...HEAD`], { cwd: wt.path });
    assert.equal(shown, stdout, 'and the diff is the one this always gave, not an error');
  } finally {
    await cleanUp(cfg);
  }
});

// A ticket's diff is read by a model on a budget, and the size of a change and
// the size of its diff are unrelated: t-mimi's was one function and two tests,
// plus a generated 15,862-row CSV it had committed. Review spent its whole $3 on
// the first request, before it had read anything.

/** Lines that look like generated output: dense, numeric and endless. */
function rows(tag: string, n: number): string {
  const body = Array.from({ length: n }, (_, i) => `${i},${i * 1.5},${i * 2.5},${i * 3.5}`);
  return [`# ${tag}`, ...body, ''].join('\n');
}

/** What git itself would have handed over, for comparison. */
async function rawDiff(cwd: string): Promise<string> {
  const { stdout } = await run('git', ['diff', 'main...HEAD'], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

test('a generated file is reduced to its stat line, and the real change is untouched', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.mkdir(path.join(wt.path, 'agent_made'));
    await fs.writeFile(path.join(wt.path, 'agent_made', 'geometry.csv'), rows('geometry', 15862));
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, done properly\n');
    await commitAll(wt, 'implement: the work, and the data it produced');

    const shown = await diff(cfg, wt);

    assert.match(shown, /^\+the work, done properly$/m, 'the change itself is all still there');
    assert.doesNotMatch(shown, /^\+9000,/m, 'the generated rows are not');
    assert.match(shown, /agent_made\/geometry\.csv/, 'but the file is still named');
    assert.match(shown, /15863/, 'and how much of it was left out is said');

    const raw = await rawDiff(wt.path);
    assert.ok(
      shown.length < raw.length / 10,
      `the size is the cost: ${shown.length} of ${raw.length} characters`,
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('many files with nothing large in any one of them are cut down too', async () => {
  // The other way to be too big, and it needed solving as well: a mechanical
  // change across a few hundred files, no single one of them over the per-file
  // cap. The largest go first, so the most files stay readable in full.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    const many = 80;
    for (let i = 0; i < many; i++) {
      await fs.writeFile(path.join(wt.path, 'project', `part${i}.csv`), rows(`part${i}`, i * 10));
    }
    await commitAll(wt, 'implement: a great many files');

    const shown = await diff(cfg, wt);
    const raw = await rawDiff(wt.path);

    assert.ok(shown.length < raw.length / 2, `${shown.length} of ${raw.length} characters`);
    for (let i = 0; i < many; i++) {
      assert.match(shown, new RegExp(`project/part${i}\\.csv`), `part${i} is still named`);
    }
    assert.match(shown, /^\+# part0$/m, 'and the smallest are still there to be read');
    assert.doesNotMatch(shown, /^\+# part79$/m, 'while the largest gave up its body');
  } finally {
    await cleanUp(cfg);
  }
});

test('an ordinary change is passed through exactly as git wrote it', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, improved\n');
    await fs.writeFile(path.join(wt.path, 'project', 'new.py'), 'and something new\n');
    await commitAll(wt, 'implement: the work');

    assert.equal(await diff(cfg, wt), await rawDiff(wt.path), 'nothing to save, nothing done');
  } finally {
    await cleanUp(cfg);
  }
});

/** A commit landing on the base while a ticket is busy — another ticket merging. */
async function landOnBase(cfg: GitConfig, file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(cfg.repoRoot, file), content);
  await run('git', ['add', '-A'], { cwd: cfg.repoRoot });
  await run('git', ['commit', '-m', `landed ${file}`], { cwd: cfg.repoRoot });
}

test('a branch that already has the base is left completely alone', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });

    assert.deepEqual(await refresh(cfg, 't1'), { kind: 'up-to-date' });

    const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
    assert.equal(after.stdout, before.stdout, 'no commit, so nothing to re-check');
  } finally {
    await cleanUp(cfg);
  }
});

test('a base that moved on is merged in, and is then on disk to work against', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await landOnBase(cfg, 'project/other.py', 'work that landed first\n');

    const result = await refresh(cfg, 't1');

    assert.equal(result.kind, 'merged');
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'other.py'), 'utf8'),
      'work that landed first\n',
      'the ticket is now working against what is actually there',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('a conflict is reported, and the branch is left exactly as it was', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');
    const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });

    await landOnBase(cfg, 'project/model.py', 'the base says this\n');

    const result = await refresh(cfg, 't1');

    assert.equal(result.kind, 'conflicted');
    assert.deepEqual(result.kind === 'conflicted' ? result.paths : [], ['project/model.py']);
    assert.equal(
      result.kind === 'conflicted' ? result.with : '',
      result.kind === 'conflicted' ? result.base : 'x',
      'and what it would not merge was the base',
    );
    assert.equal(result.kind === 'conflicted' && result.merging, false, 'nothing left going');

    const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
    assert.equal(after.stdout, before.stdout, 'no half-merged branch to clean up');
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'model.py'), 'utf8'),
      'the ticket said this\n',
      'and no conflict markers left in the work',
    );
  } finally {
    await cleanUp(cfg);
  }
});

/** A ticket that has offered its work: a branch with a commit on it, nothing merged. */
async function offeredWork(cfg: GitConfig, ticketId: string, file: string, content: string) {
  const wt = await create(cfg, ticketId);
  await fs.mkdir(path.dirname(path.join(wt.path, file)), { recursive: true });
  await fs.writeFile(path.join(wt.path, file), content);
  await commitAll(wt, `${ticketId} did the work`);
  return wt;
}

test('the work a ticket waited for is merged in, and is then on disk to build on', async () => {
  const cfg = await scratchRepo();
  try {
    await offeredWork(cfg, 't1', 'project/first.py', 'what t1 wrote\n');
    await offeredWork(cfg, 't2', 'project/second.py', 'what t2 wrote\n');
    const wt = await create(cfg, 't3');

    const result = await refresh(cfg, 't3', ['wb/t1', 'wb/t2']);

    assert.equal(result.kind, 'merged');
    assert.deepEqual(
      result.kind === 'merged' ? result.merged : [],
      ['wb/t1', 'wb/t2'],
      'and it says what it took, so the caller can record it',
    );
    // Both of them: two dependencies offered at once is the ordinary case, and a
    // ticket that got only the first would be built on half of what it waited for.
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'first.py'), 'utf8'),
      'what t1 wrote\n',
    );
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'second.py'), 'utf8'),
      'what t2 wrote\n',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('work that already landed in the base is not merged a second time', async () => {
  const cfg = await scratchRepo();
  try {
    // t1 offered, and then its pull request was merged — so its branch is in the
    // base, and a ticket cut afterwards already has everything it waited for.
    await offeredWork(cfg, 't1', 'project/first.py', 'what t1 wrote\n');
    await run('git', ['merge', '--no-edit', 'wb/t1'], { cwd: cfg.repoRoot });
    await create(cfg, 't2');

    assert.deepEqual(await refresh(cfg, 't2', ['wb/t1']), { kind: 'up-to-date' });
  } finally {
    await cleanUp(cfg);
  }
});

test('a dependency that will not merge is named, and what merged before it stands', async () => {
  const cfg = await scratchRepo();
  try {
    await offeredWork(cfg, 't1', 'project/shared.py', 'what t1 wrote\n');
    await offeredWork(cfg, 't2', 'project/shared.py', 'what t2 wrote, differently\n');
    const wt = await create(cfg, 't3');
    const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });

    const result = await refresh(cfg, 't3', ['wb/t1', 'wb/t2']);

    assert.equal(result.kind, 'conflicted');
    assert.equal(result.kind === 'conflicted' ? result.with : '', 'wb/t2');
    assert.deepEqual(result.kind === 'conflicted' ? result.paths : [], ['project/shared.py']);

    // t1 merged cleanly first and is left where it is: the ticket is as far along
    // as it got, and throwing that away would be work redone for nothing.
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'shared.py'), 'utf8'),
      'what t1 wrote\n',
      'no conflict markers, and t1 still merged',
    );
    const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
    assert.notEqual(after.stdout, before.stdout, 'the first merge is a commit on the branch');
    await assert.rejects(
      run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: wt.path }),
      'and no merge is left in progress',
    );

    // Which is said in the result as well as left on disk: a caller told only that
    // it conflicted would record the branch as being where it no longer is.
    assert.deepEqual(result.kind === 'conflicted' ? result.merged : [], ['wb/t1']);
    assert.equal(
      result.kind === 'conflicted' ? result.commit : '',
      after.stdout.trim(),
      'and the commit it reports is the one the branch is standing on',
    );
    await run('git', ['merge-base', '--is-ancestor', 'wb/t1', after.stdout.trim()], {
      cwd: wt.path,
    });
  } finally {
    await cleanUp(cfg);
  }
});

test('a conflict a stage is going to resolve is left in the worktree', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');

    await landOnBase(cfg, 'project/model.py', 'the base says this\n');

    const result = await refresh(cfg, 't1', [], true);

    assert.equal(result.kind, 'conflicted');
    assert.equal(result.kind === 'conflicted' && result.merging, true, 'and left for the stage');
    const merging = await run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: wt.path });
    assert.match(merging.stdout.trim(), /^[0-9a-f]{40}$/, 'the merge is still going');

    const model = await fs.readFile(path.join(wt.path, 'project', 'model.py'), 'utf8');
    assert.match(model, /the ticket said this/, 'with the stage’s own side');
    assert.match(model, /the base says this/, 'and the one it has to take in');
  } finally {
    await cleanUp(cfg);
  }
});

test('a merge nobody finished is undone, and the branch stands where it stood', async () => {
  // The way back out of a resolution that did not land: the run that was handed the
  // merge left it unfinished, so the offer goes to the manager as it was rather than
  // half-resolved. Protected paths, because an abort rewrites the tree and could put
  // the workbench's own source back on disk.
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');
    const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });

    await landOnBase(cfg, 'project/model.py', 'the base says this\n');
    assert.equal((await refresh(cfg, 't1', [], true)).kind, 'conflicted');
    // And the run got half way through resolving it before giving up.
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'a resolution, unfinished\n');

    await abandonMerge(cfg, 't1');

    await assert.rejects(
      run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: wt.path }),
      'no merge left going',
    );
    const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
    assert.equal(after.stdout, before.stdout, 'and nothing committed');
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'model.py'), 'utf8'),
      'the ticket said this\n',
      'the work as it was offered, with neither the markers nor the half-resolution in it',
    );
    assert.equal(await present(path.join(wt.path, 'workbench')), false, 'and still off disk');
  } finally {
    await cleanUp(cfg);
  }
});

test('a dependency with no branch of its own is nothing to merge', async () => {
  const cfg = await scratchRepo();
  try {
    await create(cfg, 't2');

    // Released by being cancelled before it ever cut a branch. Asking git to merge
    // a ref that is not there would read as a conflict, which it is not.
    assert.deepEqual(await refresh(cfg, 't2', ['wb/t1']), { kind: 'up-to-date' });
  } finally {
    await cleanUp(cfg);
  }
});

test('a conflict kept for a stage still keeps the workbench off disk', async () => {
  // Every real config protects a path, so this is the shape every conflict handed to a
  // stage in earnest has: hiding them again rewrites the index, and here it is an
  // unmerged one. Both halves have to survive that — the merge is the whole point of
  // keeping it, and the workbench being on disk would put it in reach of every tool.
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');
    await landOnBase(cfg, 'project/model.py', 'the base says this\n');
    // And the same commit touches a protected path, so the merge has to write one out.
    await landOnBase(cfg, 'workbench/src/rules.ts', 'the guardrails, revised\n');

    const result = await refresh(cfg, 't1', [], true);

    assert.equal(result.kind, 'conflicted');
    assert.equal(result.kind === 'conflicted' && result.merging, true, 'left for the stage');
    const merging = await run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: wt.path });
    assert.match(merging.stdout.trim(), /^[0-9a-f]{40}$/, 'and the merge really is still going');

    assert.equal(
      await present(path.join(wt.path, 'workbench')),
      false,
      'still beyond every tool an agent has',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('a merge resolved to our own side is still concluded', async () => {
  // The stage read both sides and decided ours already said it, so nothing is staged
  // and the tree is unchanged. The merge commit is still owed: without it `MERGE_HEAD`
  // stays set, no base is recorded, and the ticket believes it took in work it did not.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');
    await landOnBase(cfg, 'project/model.py', 'the base says this\n');
    await refresh(cfg, 't1', [], true);

    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');

    assert.match(
      (await commitAll(wt, 'implement: the ticket (t1)')) ?? '',
      /^[0-9a-f]{40}$/,
      'a commit, though it changes not one line',
    );
    assert.deepEqual(await refresh(cfg, 't1'), { kind: 'up-to-date' }, 'and the base is in');
  } finally {
    await cleanUp(cfg);
  }
});

test('a merge a stopped run left behind is handed over again, not thrown away', async () => {
  // The run given it edited the files and staged them, then asked a question and
  // stopped, so the merge is still going. Merging on top of that fails, and the
  // failure used to be tidied up with `merge --abort`: an hour of resolution gone,
  // with nothing recorded to say it ever existed.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');
    await landOnBase(cfg, 'project/model.py', 'the base says this\n');
    await refresh(cfg, 't1', [], true);

    const union = 'the ticket said this\nthe base says this\n';
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), union);
    await run('git', ['add', 'project/model.py'], { cwd: wt.path });

    const result = await refresh(cfg, 't1', [], true);

    assert.equal(result.kind, 'conflicted');
    assert.equal(result.kind === 'conflicted' && result.merging, true, 'the same merge, still on');
    assert.deepEqual(
      result.kind === 'conflicted' ? result.paths : ['?'],
      [],
      'and nothing unmerged left to count, which is why the merge is what says so',
    );
    const head = await run('git', ['rev-parse', 'MERGE_HEAD'], { cwd: wt.path });
    assert.equal(
      result.kind === 'conflicted' ? result.base : '',
      head.stdout.trim(),
      'named for what the worktree is actually merging, not what it would merge today',
    );
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'model.py'), 'utf8'),
      union,
      'and the work of the run that stopped is still here',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('a merge handed to a stage is finished only when the markers are gone', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');
    await landOnBase(cfg, 'project/model.py', 'the base says this\n');
    await refresh(cfg, 't1', [], true);

    assert.deepEqual(
      await unresolved(cfg, 't1', ['project/model.py']),
      ['project/model.py'],
      'unmerged, and full of markers',
    );

    // The union of both sides, which is what these resolutions almost always are.
    await fs.writeFile(
      path.join(wt.path, 'project', 'model.py'),
      'the ticket said this\nthe base says this\n',
    );
    assert.deepEqual(
      await unresolved(cfg, 't1', ['project/model.py']),
      ['project/model.py'],
      'edited but never staged is still unmerged',
    );

    await run('git', ['add', 'project/model.py'], { cwd: wt.path });
    assert.deepEqual(await unresolved(cfg, 't1', ['project/model.py']), [], 'resolved');
  } finally {
    await cleanUp(cfg);
  }
});

test('a marker in a file nobody was asked about does not count', async () => {
  // A fixture that has always held one is not this stage's business, and failing a
  // run for it would be failing it for something it did not do.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(
      path.join(wt.path, 'project', 'fixture.txt'),
      `${'<'.repeat(7)} theirs\nsomething a test parses\n`,
    );

    assert.deepEqual(await unresolved(cfg, 't1', ['project/model.py']), []);
    assert.deepEqual(await unresolved(cfg, 't1', ['project/fixture.txt']), ['project/fixture.txt']);
  } finally {
    await cleanUp(cfg);
  }
});

/** Where a branch stands, which is the commit its ticket measures its work from. */
const headOf = async (cwd: string): Promise<string> =>
  (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

test('a branch that deletes what the base added since it was cut is named for it', async () => {
  // What reviewers were reading as the ticket's own work: main gained a file while
  // the branch was being built, the branch took it in with the base and then
  // removed it, and the diff said the ticket had deleted it.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    const cut = await headOf(wt.path);
    await landOnBase(cfg, 'project/deps.lock', 'a dependency main gained\n');
    await refresh(cfg, 't1');

    await fs.rm(path.join(wt.path, 'project', 'deps.lock'));
    await commitAll(wt, 'untracked as the review asked');

    assert.deepEqual(await removedFromBase(cfg, 't1', cut), ['project/deps.lock']);
  } finally {
    await cleanUp(cfg);
  }
});

test('deleting a file that was there when the branch was cut is the ticket’s own business', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    const cut = await headOf(wt.path);
    await landOnBase(cfg, 'project/deps.lock', 'a dependency main gained\n');
    await refresh(cfg, 't1');

    assert.deepEqual(await removedFromBase(cfg, 't1', cut), [], 'nothing deleted at all');

    await fs.rm(path.join(wt.path, 'project', 'model.py'));
    await commitAll(wt, 'the work this ticket was for');

    assert.deepEqual(await removedFromBase(cfg, 't1', cut), [], 'older than the base gained it');
  } finally {
    await cleanUp(cfg);
  }
});

test('a file the branch this one continues from deleted is not the base’s to reinstate', async () => {
  // An earlier ticket deleted a file as its work and was offered but not merged;
  // this one carries on from it, so the deletion is in its history before it
  // starts and the base still has the file. Measured from the anchor's own tip
  // the base would look to have just added it, and this ticket would be told to
  // put back exactly what the earlier one was for taking out.
  const cfg = await scratchRepo();
  try {
    const earlier = await create(cfg, 'd1');
    await fs.rm(path.join(earlier.path, 'project', 'model.py'));
    await commitAll(earlier, 'the work d1 was for');
    const anchor = await headOf(earlier.path);

    await create(cfg, 't1', 'wb/d1');
    await landOnBase(cfg, 'project/deps.lock', 'a dependency main gained\n');
    await refresh(cfg, 't1');

    assert.deepEqual(await removedFromBase(cfg, 't1', anchor), []);
  } finally {
    await cleanUp(cfg);
  }
});

test('a base the branch has not taken in yet is not read as files it deleted', async () => {
  // The base moved after the refresh that brought the old one in — another ticket
  // merged, or the refresh's fetch failed where this one succeeds. Everything the
  // newer base has gained is missing from the branch, and without asking whether
  // the branch has this base at all every one of those files reads as a deletion
  // of something the base just added.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    const cut = await headOf(wt.path);
    await landOnBase(cfg, 'project/deps.lock', 'a dependency main gained\n');

    assert.deepEqual(await removedFromBase(cfg, 't1', cut), []);
  } finally {
    await cleanUp(cfg);
  }
});

test('a base commit this worktree has never had is answered without throwing', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await landOnBase(cfg, 'project/deps.lock', 'a dependency main gained\n');
    await refresh(cfg, 't1');
    await fs.rm(path.join(wt.path, 'project', 'deps.lock'));
    await commitAll(wt, 'untracked as the review asked');

    // `[]` here does not distinguish the fallback from no anchor at all, and
    // cannot: this only ever runs on a branch that has just taken the base in, so
    // the merge-base of base and HEAD is the base, the window between them holds
    // no addition, and the fallback can only ever come back empty. What is being
    // asserted is the whole of what matters — a revision nobody can resolve says
    // nothing rather than inventing a block or failing the ticket outright.
    assert.deepEqual(await removedFromBase(cfg, 't1', 'deadbee'), []);
  } finally {
    await cleanUp(cfg);
  }
});

test('a merge cannot put the workbench into a protected worktree', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    // The merge has to write this file out, which is exactly what would materialise
    // a path the sparse checkout is keeping off disk.
    await landOnBase(cfg, 'workbench/src/rules.ts', 'the guardrails, revised\n');

    assert.equal((await refresh(cfg, 't1')).kind, 'merged');

    assert.equal(
      await present(path.join(wt.path, 'workbench')),
      false,
      'still beyond every tool an agent has',
    );
  } finally {
    await cleanUp(cfg);
  }
});

// Git does not serialise writes to `.git/config` for you, and the orchestrator
// starts tickets in parallel. t4 lost that race: `could not lock config file
// .git/config: File exists`, a branch left behind with half an upstream stanza,
// no worktree, and a ticket parked on a message about nothing it had done.

/** The scratch repository with somewhere to push to, so a branch gets an upstream. */
async function withOrigin(cfg: GitConfig): Promise<void> {
  const remote = path.join(path.dirname(cfg.repoRoot), 'remote.git');
  await run('git', ['init', '--bare', '-b', 'main', remote]);
  await run('git', ['remote', 'add', 'origin', remote], { cwd: cfg.repoRoot });
  await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: cfg.repoRoot });
}

/** What `.git/config` says about one branch, and nothing about any other. */
async function branchStanza(cfg: GitConfig, branch: string): Promise<string> {
  const config = await fs.readFile(path.join(cfg.repoRoot, '.git', 'config'), 'utf8');
  return config.split(`[branch "${branch}"]`)[1]?.split('[')[0] ?? '';
}

test('six tickets starting at once all get a whole worktree', async () => {
  const cfg = await scratchRepo();
  try {
    await withOrigin(cfg);
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];

    const made = await Promise.all(ids.map((id) => create(cfg, id)));

    assert.deepEqual(
      made.map((wt) => wt.ticketId),
      ids,
      'every one of them came back',
    );
    for (const wt of made) {
      assert.equal(wt.branch, `wb/${wt.ticketId}`);
      assert.equal(await present(path.join(wt.path, 'project', 'model.py')), true, wt.ticketId);
      // The half-written stanza is what the race actually produced: `remote` on its
      // own, with the `merge` line the same command was about to write missing.
      const stanza = await branchStanza(cfg, wt.branch);
      assert.match(stanza, /remote = origin/, `${wt.branch} knows its remote`);
      assert.match(stanza, /merge = refs\/heads\/main/, `${wt.branch} knows what it tracks`);
    }
  } finally {
    await cleanUp(cfg);
  }
});

test('a lock held outside this process is waited out, not failed on', async () => {
  // The in-process turn cannot see an agent session or a second workbench running
  // its own git in the same repository. A held lock clears in milliseconds, so the
  // answer is to wait rather than to park the ticket.
  const cfg = await scratchRepo();
  try {
    await withOrigin(cfg);
    const lock = path.join(cfg.repoRoot, '.git', 'config.lock');
    await fs.writeFile(lock, '');
    const release = setTimeout(() => void fs.rm(lock, { force: true }), 150);

    const wt = await create(cfg, 't1');
    clearTimeout(release);

    // The attempt that lost the lock had already made the branch, so what the retry
    // finds is a branch to check out — the recovery `create` has always had.
    assert.equal(await present(path.join(wt.path, 'project', 'model.py')), true);
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt.path });
    assert.equal(stdout.trim(), 'wb/t1');
  } finally {
    await cleanUp(cfg);
  }
});

test('a branch left behind by a failed add is checked out rather than fought over', async () => {
  const cfg = await scratchRepo();
  try {
    // Exactly the wreckage t4 was left in: the branch made, no worktree registered.
    await run('git', ['branch', 'wb/t1', 'main'], { cwd: cfg.repoRoot });

    const wt = await create(cfg, 't1');

    assert.equal(wt.base, null, 'nothing was cut — the branch was already there');
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt.path });
    assert.equal(stdout.trim(), 'wb/t1', 'and it is the one that was standing');
  } finally {
    await cleanUp(cfg);
  }
});
