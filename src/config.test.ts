import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_FILE, findHome, loadConfig, PACKAGE_ROOT } from './config.ts';

/**
 * A repository with a workbench in it, at whichever of the two shapes is asked for.
 * `WB_HOME` is cleared because it settles the search outright, and a machine that
 * happens to have one set would pass these tests without exercising anything.
 */
function repoWith(where: '.' | '.workbench', config: Record<string, unknown> = {}): string {
  delete process.env['WB_HOME'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-config-'));
  const home = path.resolve(root, where);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, CONFIG_FILE), JSON.stringify(config));
  return root;
}

test('the workbench is found from anywhere in the project it works on', () => {
  const root = repoWith('.workbench');
  const deep = path.join(root, 'src', 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });

  assert.equal(findHome(root), path.join(root, '.workbench'));
  assert.equal(findHome(deep), path.join(root, '.workbench'), 'from a subdirectory too');

  fs.rmSync(root, { recursive: true, force: true });
});

test('a workbench living in a directory of its own is found where it is', () => {
  // The shape this workbench has itself, which predates `wb init` and must keep
  // working: the config file beside the code rather than in `.workbench`.
  const root = repoWith('.');
  assert.equal(findHome(root), root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('no config anywhere above is an answer, not a crash', () => {
  delete process.env['WB_HOME'];
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bare-'));
  assert.equal(findHome(nowhere), undefined);
  fs.rmSync(nowhere, { recursive: true, force: true });
});

test('everything a project owns resolves against its home, not against the code', () => {
  const root = repoWith('.workbench', { base: 'trunk', protectedPaths: ['secrets'] });
  const home = path.join(root, '.workbench');
  const config = loadConfig(home);

  assert.equal(config.repoRoot, root, 'the repository is the one the home sits in');
  assert.equal(config.dbPath, path.join(home, 'data', 'workbench.db'));
  assert.equal(config.worktreeRoot, path.join(home, '.worktrees'));
  assert.equal(config.pluginRoot, home, 'skills are the project’s, not the workbench’s');
  assert.equal(config.base, 'trunk', 'the file wins over the default');
  assert.equal(config.checksTimeoutMinutes, 20, 'and a default stands where the file is silent');

  // Worked out rather than configured: a workbench an agent could write to is one
  // that can rewrite its own instructions mid-ticket.
  assert.deepEqual(config.protectedPaths, ['.workbench', 'secrets']);

  fs.rmSync(root, { recursive: true, force: true });
});

test('the project may replace an agent without forking the rest', () => {
  const root = repoWith('.workbench');
  const home = path.join(root, '.workbench');
  const { agentDirs } = loadConfig(home);

  assert.deepEqual(agentDirs, [path.join(home, 'agents'), path.join(PACKAGE_ROOT, 'agents')]);

  fs.rmSync(root, { recursive: true, force: true });
});
