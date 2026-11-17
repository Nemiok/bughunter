import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { defineHostDescriptor, hostPaths, mcpToolName } from '../hosts/descriptor.mjs';
import { qwenHost } from '../hosts/qwen.mjs';

test('qwen descriptor preserves the installed layout', () => {
  assert.equal(qwenHost.id, 'qwen');
  assert.equal(qwenHost.outDir, 'dist/bughunter');
  assert.equal(qwenHost.pluginRoot, '${CLAUDE_PLUGIN_ROOT}');
  assert.equal(mcpToolName(qwenHost, 'bh_start_run'), 'mcp__bughunter__bh_start_run');
  const paths = hostPaths(qwenHost, '/tmp/project', 'web');
  assert.equal(paths.optIn, join('/tmp/project', '.qwen', 'bughunter.json'));
  assert.equal(paths.stateDir, join('/tmp/project', '.qwen', 'bughunter', 'state', 'web'));
  assert.equal(paths.configPath, join(paths.stateDir, 'config.json'));
});

test('descriptor rejects absolute and escaping project paths', () => {
  for (const [field, value] of [['optInPath', '/tmp/x'], ['stateRoot', '../x']]) {
    assert.throws(
      () => defineHostDescriptor({ ...qwenHost, [field]: value }),
      new Error(`HOST_DESCRIPTOR_INVALID: ${field}`),
    );
  }
});

test('MCP tool naming accepts only Bughunter tool identifiers', () => {
  assert.throws(() => mcpToolName(qwenHost, 'Read'), /MCP_TOOL_INVALID: Read/);
});
