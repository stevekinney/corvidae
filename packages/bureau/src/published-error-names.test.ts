import { describe, expect, it } from 'bun:test';

import { publishableErrorCode, publishableErrorKind } from './published-error-names';

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
