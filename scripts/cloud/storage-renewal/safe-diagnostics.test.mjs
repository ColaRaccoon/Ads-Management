import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenewalDiagnostics } from './safe-diagnostics.mjs';

test('provider errors expose status and approved codes without response details', () => {
  const diagnostics = createRenewalDiagnostics();
  diagnostics.railway('VARIABLE_READ');
  diagnostics.status(200);
  diagnostics.at('RAILWAY_RESPONSE_PARSE');
  diagnostics.graphql([
    { message: 'private provider response', extensions: { code: 'FORBIDDEN' } },
    { message: 'another private response', extensions: { code: 'private-code' } }
  ]);
  const result = diagnostics.failure(new Error('RAILWAY_REQUEST_FAILED'));
  assert.equal(result.railwayOperation, 'VARIABLE_READ');
  assert.equal(result.railwayHttpStatus, 200);
  assert.deepEqual(result.railwayGraphqlCodes, ['FORBIDDEN', 'OTHER']);
  assert.equal(result.reason, 'RAILWAY_REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('HTTP rejection remains distinguishable from JSON or transport failure', () => {
  const diagnostics = createRenewalDiagnostics();
  diagnostics.railway('VARIABLE_READ');
  assert.equal(diagnostics.failure(new TypeError('private transport')).railwayHttpStatus, null);
  diagnostics.status(401);
  diagnostics.at('RAILWAY_RESPONSE_PARSE');
  const result = diagnostics.failure(new SyntaxError('private response body'));
  assert.equal(result.railwayHttpStatus, 401);
  assert.equal(result.stage, 'RAILWAY_RESPONSE_PARSE');
  assert.equal(result.reason, 'UNCLASSIFIED');
});

test('unexpected labels and credential-bearing error content never become log fields', () => {
  const diagnostics = createRenewalDiagnostics();
  const privateValue = 'sensitive-value-that-must-never-appear';
  diagnostics.at(privateValue);
  diagnostics.railway(privateValue);
  diagnostics.status(privateValue);
  diagnostics.graphql([{ extensions: { code: privateValue }, token: privateValue }]);
  const error = new Error(privateValue);
  error.request = { authorization: privateValue };
  const result = diagnostics.failure(error);
  assert.equal(result.stage, 'RAILWAY_FETCH');
  assert.equal(result.railwayOperation, 'UNKNOWN');
  assert.equal(result.railwayHttpStatus, null);
  assert.equal(result.reason, 'UNCLASSIFIED');
  assert.ok(!JSON.stringify(result).includes(privateValue));
});

test('a second provider request clears stale response metadata', () => {
  const diagnostics = createRenewalDiagnostics();
  diagnostics.railway('VARIABLE_READ');
  diagnostics.status(200);
  diagnostics.graphql([{ extensions: { code: 'FORBIDDEN' } }]);
  diagnostics.railway('DEPLOYMENT_STATUS');
  const result = diagnostics.failure(new Error('private timeout'));
  assert.equal(result.railwayOperation, 'DEPLOYMENT_STATUS');
  assert.equal(result.railwayHttpStatus, null);
  assert.deepEqual(result.railwayGraphqlCodes, []);
});

test('reporting tolerates an exception whose message getter throws', () => {
  const diagnostics = createRenewalDiagnostics();
  const error = new Error();
  Object.defineProperty(error, 'message', { get() { throw new Error('private getter'); } });
  assert.equal(diagnostics.failure(error).reason, 'UNCLASSIFIED');
});
