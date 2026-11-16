import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertPreset } from '@bughunter/core';

import { cliPreset } from '../src/preset.ts';
import { presetRoot } from './harness.ts';

const coreTools = [
  'bh_start_run',
  'bh_resume_run',
  'bh_explore_next',
  'bh_finish_run',
  'bh_report_candidate',
  'bh_reproduce',
  'bh_triage',
  'bh_export_test',
  'bh_detect_tests',
  'bh_verify_red',
  'bh_promote_finding',
];

const presetTools = ['bh_open', 'bh_state', 'bh_act', 'bh_sweep', 'bh_close'];

test('the preset declares all eighteen core fields and the expected dictionaries', () => {
  assert.doesNotThrow(() => assertPreset(cliPreset));
  assert.equal(Object.keys(cliPreset).length, 18);
  assert.deepEqual(Object.keys(cliPreset).sort(), [
    'checks', 'configSchema', 'detectors', 'errors', 'exportTarget', 'findingKinds', 'generateTest',
    'inventory', 'name', 'personas', 'profile', 'replay', 'report', 'reset', 'session', 'snapshot',
    'sweepVisit', 'testRunner',
  ]);
  assert.deepEqual(cliPreset.checks.kinds, [
    'exitCode', 'stdoutContains', 'stdoutNotContains', 'stderrContains', 'stderrNotContains', 'stdoutOccurrences',
  ]);
  assert.deepEqual([...cliPreset.detectors.kinds].sort(), ['anomaly', 'exit-code', 'stderr-stack']);
  assert.deepEqual([...cliPreset.personas.roster], ['бухгалтер', 'ревизор', 'нетерпеливый']);
});

test('the entry point answers initialize and lists exactly sixteen tools', async () => {
  const stateDir = await mkdtemp(join(presetRoot, '.test-handshake-'));
  const child = spawn(process.execPath, [join(presetRoot, 'src', 'index.ts')], {
    cwd: presetRoot,
    env: { ...process.env, BUGHUNTER_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let buffer = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) lines.push(line);
      newline = buffer.indexOf('\n');
    }
  });

  const waitFor = async (id: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = lines.find((line) => {
        try {
          return (JSON.parse(line) as { id?: unknown }).id === id;
        } catch {
          return false;
        }
      });
      if (found !== undefined) return JSON.parse(found) as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no response for id ${id}; stdout=${lines.join(' | ')}; stderr=${stderr}`);
  };

  try {
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'preset-test', version: '1.0.0' },
      },
    });
    const initialized = await waitFor(1);
    assert.equal((initialized.result as { serverInfo?: { name?: string } }).serverInfo?.name, 'bughunter');
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await waitFor(2);
    const tools = ((listed.result as { tools?: Array<{ name?: unknown }> }).tools ?? [])
      .map((tool) => tool.name);
    assert.equal(tools.length, 16);
    assert.deepEqual([...tools].sort(), [...coreTools, ...presetTools].sort());
    assert.equal(stderr, '');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
