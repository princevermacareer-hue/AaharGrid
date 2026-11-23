import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { openApiSpec } from './openapi.js';

test('documents the correct authorization mode', () => {
  const demo = openApiSpec(true);
  const normal = openApiSpec(false);
  assert.deepEqual(demo.security, [{ DemoRole: [] }]);
  assert.deepEqual(normal.security, [{ CognitoAccessToken: [] }]);
  assert.deepEqual(demo.paths['/api/health'].get.security, []);
});

test('documents resource IDs and request bodies for interactive requests', () => {
  const decision = openApiSpec(true).paths['/api/requests/{id}/decision'].patch;
  assert.equal(decision.parameters?.[0].name, 'id');
  assert.equal(decision.requestBody?.required, true);
});
