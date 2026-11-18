import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeInitLineProbe } from './qwen-harness.mjs';

test('init probe emits only when a complete init line arrives', () => {
  const events = [];
  const probe = makeInitLineProbe((event) => events.push(event));
  probe('{"type":"system","subtype":"init","qwen');
  probe('_code_version":"0.28.0"}\n');
  assert.equal(events.length, 1, 'init split across chunks must be emitted once complete');
  assert.equal(events[0].qwen_code_version, '0.28.0');
});

test('init probe tolerates non-JSON and non-init lines', () => {
  const events = [];
  const probe = makeInitLineProbe((event) => events.push(event));
  probe('qwen code startup noise\n');
  probe('{"partial":true}\n');
  probe('{"type":"assistant","subtype":"stream_event"}\n');
  probe('not json at all\n');
  assert.equal(events.length, 0, 'non-matching lines must be ignored');
  probe('{"type":"system","subtype":"init","qwen_code_version":"0.28.0"}\n');
  assert.equal(events.length, 1);
});

test('init probe keeps a partial non-init line open across chunks', () => {
  const events = [];
  const probe = makeInitLineProbe((event) => events.push(event));
  probe('{"type":"assistant","subty');
  probe('pe":"stream_event"}\n');
  assert.equal(events.length, 0, 'a reconstructed non-init line must be ignored');
  probe('{"type":"system","subtype":"init","qwen_code_version":"0.28.0"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].qwen_code_version, '0.28.0');
});
