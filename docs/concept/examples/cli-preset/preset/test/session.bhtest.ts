import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { appDirectory } from '../src/profile.ts';
import { cliReset } from '../src/reset.ts';
import {
  openCliSession, performCommand, sessionView,
} from '../src/session.ts';
import { fixtureDir, ownTemporaryDirectory, presetRoot, stateFor } from './harness.ts';

test('appDirectory finds the fixture above the workspace cwd without leaving the project', async () => {
  const previous = process.cwd();
  try {
    process.chdir(presetRoot);
    assert.equal(appDirectory('cli-app', presetRoot), fixtureDir);
  } finally {
    process.chdir(previous);
  }
});

test('a command runs without a shell, in an isolated database, and setup is journaled', async () => {
  const state = await stateFor();
  const handle = await openCliSession({
    runId: 'run-session', target: 'show <name>', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    const prepared = await performCommand(handle, {
      argv: ['show', 'apple'],
      setup: [['add', 'apple', '3']],
    }, state.config);
    assert.equal(prepared.execution.exitCode, 0);
    assert.equal(prepared.execution.stdout, '300\n');
    assert.equal(sessionView(handle).executions.length, 1, 'setup не должен попадать в executions');
    const steps = handle.steps();
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0]?.setup, [['add', 'apple', '3']]);

    const injected = join(state.stateDir, 'pwned');
    const unsafe = await performCommand(handle, {
      argv: ['add', `apple; touch ${injected}`, '1'],
    }, state.config);
    assert.equal(unsafe.execution.exitCode, 0);
    assert.match(unsafe.execution.stdout, /apple; touch/);
    assert.equal(existsSync(injected), false, 'argv прошёл через оболочку');
  } finally {
    await handle.close();
    await state.cleanup();
  }
});

test('two sessions never share the sandbox database', async () => {
  const state = await stateFor();
  const first = await openCliSession({
    runId: 'run-isolation', target: 'add <name> <qty>', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  const second = await openCliSession({
    runId: 'run-isolation', target: 'list', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    await performCommand(first, { argv: ['add', 'apple', '3'] }, state.config);
    const list = await performCommand(second, { argv: ['list'] }, state.config);
    assert.equal(list.execution.stdout, '[]\n');
  } finally {
    await first.close();
    await second.close();
    await state.cleanup();
  }
});

test('an unknown command and a mutating command under readOnly are refused before spawn', async () => {
  const state = await stateFor((config) => { config.safety.readOnly = true; });
  const handle = await openCliSession({
    runId: 'run-refusal', target: 'add <name> <qty>', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    await assert.rejects(
      performCommand(handle, { argv: ['delete', 'apple'] }, state.config),
      /COMMAND_NOT_FOUND/,
    );
    await assert.rejects(
      performCommand(handle, { argv: ['add', 'apple', '3'] }, state.config),
      /FORBIDDEN_ACTION/,
    );
    assert.equal(handle.steps().length, 0);
  } finally {
    await handle.close();
    await state.cleanup();
  }
});

test('the session step limit stops execution and keeps the journal intact', async () => {
  const state = await stateFor((config) => { config.limits.stepsPerSession = 1; });
  const handle = await openCliSession({
    runId: 'run-limit', target: 'list', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    await performCommand(handle, { argv: ['list'] }, state.config);
    await assert.rejects(performCommand(handle, { argv: ['list'] }, state.config), /LIMIT_REACHED/);
    assert.equal(handle.steps().length, 1);
  } finally {
    await handle.close();
    await state.cleanup();
  }
});

test('reset deletes only the session database', async () => {
  const state = await stateFor();
  const handle = await openCliSession({
    runId: 'run-reset', target: 'list', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    await performCommand(handle, { argv: ['add', 'apple', '3'] }, state.config);
    await cliReset.apply(handle);
    const list = await performCommand(handle, { argv: ['list'] }, state.config);
    assert.equal(list.execution.stdout, '[]\n');
    assert.equal(existsSync(join(state.stateDir, 'orders.json')), false, 'reset не должен трогать приложение');
  } finally {
    await handle.close();
    await state.cleanup();
  }
});

test('a reset without a recipe is a domain error, not a silent no-op', async () => {
  const state = await stateFor((config) => { config.reset = null; });
  const handle = await openCliSession({
    runId: 'run-reset-none', target: 'list', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    await assert.rejects(cliReset.apply(handle), /RESET_UNSUPPORTED/);
  } finally {
    await handle.close();
    await state.cleanup();
  }
});
