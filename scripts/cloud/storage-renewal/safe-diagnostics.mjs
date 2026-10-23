const STAGES = new Set([
  'REQUEST_PARSE', 'CONFIG_CHECK', 'JWKS_FETCH', 'JWKS_PARSE', 'KEY_MATCH',
  'RAILWAY_FETCH', 'RAILWAY_RESPONSE_PARSE', 'VARIABLES_VALIDATE',
  'TOKEN_VERIFY', 'TOKEN_ISSUE', 'STORAGE_PROBE', 'DEPLOYMENT_VALIDATE',
  'APPLICATION_READINESS', 'UNKNOWN'
]);
const OPERATIONS = new Set(['VARIABLE_READ', 'DEPLOYMENT_STATUS', 'TOKEN_REPLACE_OR_DEPLOY']);
const REASONS = new Set([
  'CONFIG_INVALID', 'JWKS_FAILED', 'KEY_MISMATCH', 'RAILWAY_REQUEST_FAILED',
  'UNSUPPORTED_OPERATION', 'TARGET_MISMATCH', 'TOKEN_SCOPE_MISMATCH',
  'CURRENT_TOKEN_EXPIRED', 'TOKEN_KEY_MISMATCH', 'ISSUED_TOKEN_MISMATCH',
  'UPDATE_OUTCOME_UNKNOWN_INSPECT_NO_RETRY', 'STORAGE_PROBE_FAILED'
]);
const GRAPHQL_CODES = new Set([
  'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'BAD_USER_INPUT',
  'INTERNAL_SERVER_ERROR', 'RATE_LIMITED'
]);

// Only fixed labels and bounded numeric status metadata may reach the log.
// Never copy an exception, request, query, variables, response body or headers.
export function createRenewalDiagnostics() {
  let stage = 'REQUEST_PARSE';
  let operation = null;
  let httpStatus = null;
  let graphqlCodes = [];
  return {
    at(value) { stage = STAGES.has(value) ? value : 'UNKNOWN'; },
    railway(value) {
      stage = 'RAILWAY_FETCH';
      operation = OPERATIONS.has(value) ? value : 'UNKNOWN';
      httpStatus = null;
      graphqlCodes = [];
    },
    status(value) {
      httpStatus = Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
    },
    graphql(errors) {
      graphqlCodes = Array.isArray(errors)
        ? [...new Set(errors.slice(0, 8).map(error => {
          const code = error?.extensions?.code;
          return GRAPHQL_CODES.has(code) ? code : 'OTHER';
        }))]
        : [];
    },
    failure(error) {
      let reason = 'UNCLASSIFIED';
      try {
        if (error instanceof Error && REASONS.has(error.message)) reason = error.message;
      } catch { /* An unusual error getter must not expose data or break reporting. */ }
      return {
        event: 'STORAGE_RENEWAL_FAILED_INSPECT_PROVIDER_STATE',
        diagnosticVersion: 1,
        stage,
        railwayOperation: operation,
        railwayHttpStatus: httpStatus,
        railwayGraphqlCodes: [...graphqlCodes],
        reason
      };
    }
  };
}
