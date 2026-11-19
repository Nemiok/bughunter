import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeQwenTranscript } from './normalize-qwen-transcript.mjs';

test('normalizes host lines, foreground defaults and node explorer aliases', () => {
  const event = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'agent-1', name: 'Agent',
        input: { subagent_type: 'bughunter:bh-explorer-node', prompt: 'explore' },
      }],
    },
  };
  const result = normalizeQwenTranscript([
    'Reloading plugins...',
    JSON.stringify(event),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n'));
  const lines = result.text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message.content[0].input.subagent_type, 'bughunter:bh-explorer');
  assert.equal(lines[0].message.content[0].input.run_in_background, false);
  assert.equal(result.normalizedExplorers, 1);
  assert.equal(result.normalizedAgents, 1);
});
