import { describe, expect, it } from 'bun:test';

import {
  publishableErrorCode,
  publishableErrorKind,
  publishableFinishReason,
  publishablePluginStatus,
  publishableProblemCodes,
  publishableSecretKey,
  publishableSteeringFailureReason,
  publishableToken,
} from './published-error-names';

/** Every `AgentRunErrorCode` and every code Armorer assigns a tool failure: all must be publishable. */
const KNOWN_CODES = [
  'INVALID_EXPORT',
  'LOAD_FAILED',
  'ABORTED',
  'BUDGET_EXCEEDED',
  'ELICITATION_DENIED',
  'GENERATED_MEDIA_NOT_ADMITTED',
  'INVALID_AGENT_HANDLE',
  'INVALID_OUTPUT',
  'MAXIMUM_STEPS',
  'MEDIA_NOT_ADMITTED',
  'NON_JSON_OUTPUT',
  'OUTPUT_SCHEMA_CONVERSION_FAILED',
  'RESPONSE_PARTS_MISMATCH',
  'SELECTION_REVALIDATION_FAILED',
  'SUBAGENT_RUN_FAILED',
  'TRIPWIRE',
  'UNKNOWN',
  'UNSUPPORTED_MEDIA_TYPE',
  'VALIDATION_ERROR',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'TOOL_UNAVAILABLE',
  'CONFLICT',
  'TRANSIENT_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'INTERNAL_ERROR',
];

describe('what a pushed event may name of a failure (COR-2095, Revision 2026-11-16)', () => {
  it.each(KNOWN_CODES)('publishes the code %s as it is', (code) => {
    expect(publishableErrorCode(code, 'FALLBACK')).toBe(code);
  });

  it.each([
    'rate limited',
    'rate_limited',
    'RATE LIMITED',
    'RATE-LIMITED',
    '1_STARTS_WITH_A_DIGIT',
    'password=hunter2',
    '',
    'A'.repeat(65),
    ' UNKNOWN',
    'UNKNOWN\n',
  ])('replaces the code %j with the fallback', (code) => {
    expect(publishableErrorCode(code, 'FALLBACK')).toBe('FALLBACK');
  });

  it.each([[undefined], [null], [429], [{}], [[['UNKNOWN']]]])(
    'replaces a code that is not a string: %j',
    (code) => {
      expect(publishableErrorCode(code, 'FALLBACK')).toBe('FALLBACK');
    },
  );

  it('publishes a code of 64 characters', () => {
    expect(publishableErrorCode('A'.repeat(64), 'FALLBACK')).toBe('A'.repeat(64));
  });

  it.each(['load', 'contract', 'generate', 'tool', 'abort', 'output', 'policy'])(
    'publishes the kind %s',
    (kind) => {
      expect(publishableErrorKind(kind)).toBe(kind);
    },
  );

  it.each(['provider', 'Generate', 'generate ', 'a free-text kind', '', undefined, null, 7])(
    'omits the kind %j',
    (kind) => {
      expect(publishableErrorKind(kind)).toBeUndefined();
    },
  );
});

describe('what a pushed event may name of a plugin and its secret (COR-2098)', () => {
  it.each(['running', 'needs-setup', 'disabled', 'skipped'])(
    'publishes the status %s',
    (status) => {
      expect(publishablePluginStatus(status)).toBe(status);
    },
  );

  it.each(['Running', 'needs setup', 'broken', '', undefined, null, 1])(
    'omits the status %j',
    (status) => {
      expect(publishablePluginStatus(status)).toBeUndefined();
    },
  );

  it('publishes the problem codes it is given once each, in order, and refuses a list with anything else in it', () => {
    expect(publishableProblemCodes([])).toEqual([]);
    expect(publishableProblemCodes(['secret-missing', 'panel-changed', 'secret-missing'])).toEqual([
      'secret-missing',
      'panel-changed',
    ]);
    expect(publishableProblemCodes(['secret-missing', 'the key is missing'])).toBeUndefined();
    expect(publishableProblemCodes(['toString'])).toBeUndefined();
    expect(publishableProblemCodes([{ code: 'secret-missing' }])).toBeUndefined();
    expect(publishableProblemCodes('secret-missing')).toBeUndefined();
    expect(publishableProblemCodes(undefined)).toBeUndefined();
  });

  it.each(['kit-api-key', 'a', '0-key', 'a'.repeat(128)])('publishes the key %s', (key) => {
    expect(publishableSecretKey(key)).toBe(key);
  });

  it.each(['Kit-Key', '-key', 'kit key', 'kit_key', 'key\n', 'a'.repeat(129), '', undefined, 9])(
    'omits the key %j',
    (key) => {
      expect(publishableSecretKey(key)).toBeUndefined();
    },
  );
});

describe('what a pushed event may name of a child run, a steering command and a hook (COR-2097)', () => {
  it.each([
    'stop-condition',
    'maximum-steps',
    'aborted',
    'error',
    'elicitation-denied',
    'budget-exceeded',
    'tripwire',
  ])('publishes the finish reason %s as it is', (reason) => {
    expect(publishableFinishReason(reason, 'error')).toBe(reason);
  });

  it.each(['failed', 'Error', 'error ', 'the provider said no', '', undefined, null, 4, {}])(
    'replaces the finish reason %j with the fallback',
    (reason) => {
      expect(publishableFinishReason(reason, 'FALLBACK')).toBe('FALLBACK');
    },
  );

  it.each([
    'session-terminal',
    'run-terminal',
    'run-ambiguous',
    'authorization-revoked',
    'policy-denied',
    'model-not-allowed',
    'stale-revision',
    'shutting-down',
    'deadline-passed',
    'superseded-by',
  ])('publishes the steering reason %s as it is', (reason) => {
    expect(publishableSteeringFailureReason(reason)).toBe(reason);
  });

  it.each(['denied', 'Policy-Denied', 'policy-denied ', 'because I said so', '', undefined, 3])(
    'omits the steering reason %j',
    (reason) => {
      expect(publishableSteeringFailureReason(reason)).toBeUndefined();
    },
  );

  it.each([
    'agent:own',
    'plugin:audit:guard',
    'audit',
    '@scope/plugin',
    'a.b_c-d',
    '1.0.0',
    'v2024-11-01',
    'a'.repeat(128),
  ])('publishes the token %s as it is', (name) => {
    expect(publishableToken(name)).toBe(name);
  });

  it.each([
    'two words',
    ' leading',
    'trailing ',
    'new\nline',
    'password=hunter2',
    '-starts-with-a-dash',
    'a'.repeat(129),
    '',
    undefined,
    null,
    9,
  ])('omits the token %j', (name) => {
    expect(publishableToken(name)).toBeUndefined();
  });
});
