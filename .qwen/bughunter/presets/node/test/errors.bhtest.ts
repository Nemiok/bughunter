import assert from 'node:assert/strict';
import { test } from 'node:test';

import { errorCode, nodeDomainCodes, nodeErrors, ToolError } from '../src/errors.ts';

test('preset and translated core codes reach the model as themselves', () => {
  assert.equal(errorCode(new ToolError('CONFIG_CREATED: /tmp/state/config.json')).code, 'CONFIG_CREATED');
  assert.equal(errorCode(new Error('INVENTORY_EMPTY: инвентарь пуст')).code, 'ENDPOINT_NOT_FOUND');
  assert.equal(errorCode(new Error('TARGETS_EMPTY')).code, 'ENDPOINT_NOT_FOUND');
  assert.equal(errorCode(new Error('TARGET_NOT_ALLOWED: GET /nope')).code, 'TARGET_NOT_ALLOWED');
  assert.equal(errorCode(new Error('LIMIT_REACHED')).code, 'LIMIT_REACHED');
  assert.equal(errorCode(new Error('FORBIDDEN_ACTION: DELETE при readOnly')).code, 'FORBIDDEN_ACTION');
  assert.equal(errorCode(new Error('LEASE_REQUIRED: run-1')).code, 'LEASE_REQUIRED');
  assert.equal(errorCode(new Error('LEASE_MISMATCH: run-1')).code, 'LEASE_MISMATCH');
  assert.equal(errorCode(new Error('EXPLORER_BUSY')).code, 'EXPLORER_BUSY');
  assert.equal(errorCode(new Error('CONFIG_NOT_FOUND: /tmp/state/config.json')).code, 'CONFIG_INVALID');
  assert.equal(errorCode(new Error('CONFIG_INVALID: /tmp/x: baseBranch: Required')).code, 'CONFIG_INVALID');
  assert.equal(errorCode(new Error('CANDIDATE_UNREPRODUCED: id')).code, 'CANDIDATE_UNREPRODUCED');
  assert.equal(errorCode(new Error('SIGNAL_NOT_FOUND: sig-1')).code, 'NOT_FOUND');
});

test('every declared domain code survives the mapping', () => {
  assert.ok(nodeDomainCodes.length >= 10);
  for (const code of nodeDomainCodes) {
    assert.equal(errorCode(new Error(`${code}: подробности`)).code, code, `код потерялся: ${code}`);
  }
  for (const [neutral, translated] of Object.entries(nodeErrors.codes)) {
    assert.equal(errorCode(new Error(`${neutral}: подробности`)).code, translated);
  }
});

test('an unknown crash is reported as TOOL_FAILED with the original message', () => {
  const mapped = errorCode(new TypeError('Cannot read properties of undefined'));
  assert.equal(mapped.code, 'TOOL_FAILED');
  assert.match(mapped.message, /Cannot read properties/);
  assert.equal(errorCode('строка вместо ошибки').code, 'TOOL_FAILED');
});
