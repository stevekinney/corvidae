import { describe, expect, test } from 'bun:test';

import { panelResultText } from './tool-call-panel-result.ts';

const PROPOSAL = { status: 'ok', id: 'flow', baseHash: 'abc', proposedText: '{}' };

describe('panelResultText', () => {
  test('hands the panel a result that did the work, serialized', () => {
    expect(panelResultText(PROPOSAL)).toBe(JSON.stringify(PROPOSAL));
    expect(panelResultText(JSON.stringify(PROPOSAL))).toBe(JSON.stringify(PROPOSAL));
  });

  test('opens no panel over an invalid proposal', () => {
    const invalid = { status: 'invalid', code: 'schema', issues: [{ message: 'bad trigger' }] };
    expect(panelResultText(invalid)).toBeUndefined();
    expect(panelResultText(JSON.stringify(invalid))).toBeUndefined();
  });

  test('opens no panel over a stale proposal, whose file changed since it was made', () => {
    const stale = {
      status: 'conflict',
      id: 'flow',
      reason: 'workflow-file-changed',
      currentHash: 'def',
    };
    expect(panelResultText(stale)).toBeUndefined();
  });

  test.each([
    { status: 'not-found', id: 'flow' },
    { status: 'forbidden', message: 'No.' },
  ])('opens no panel over a refusal: $status', (refusal) => {
    expect(panelResultText(refusal)).toBeUndefined();
  });

  test('hands a plugin tool’s own result, which has no status, to its panel', () => {
    expect(panelResultText({ rows: [1, 2] })).toBe('{"rows":[1,2]}');
  });

  test.each([undefined, null, 4, 'not json', '[1]', [1], '"text"'])(
    'opens no panel over a result that is not an object: %p',
    (result) => {
      expect(panelResultText(result)).toBeUndefined();
    },
  );
});
