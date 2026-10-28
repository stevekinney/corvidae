/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. A form field, accept token, or chart key named `constructor` must be an ordinary name.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';

import { normalizeBarData } from './_internal/chart/chart-bar-data.ts';
import { formatAcceptDescription } from './components/file-upload/file-upload-utilities.ts';
import { issuesByPath } from './components/schema-form/schema-form-validation.ts';

describe('a form field named constructor', () => {
  test('keeps its validation message', () => {
    expect(issuesByPath([{ path: ['constructor'], message: 'Required' }])).toEqual({
      constructor: 'Required',
    });
  });
});

describe('an accept token named constructor', () => {
  test('is described by its own text, not by Object', () => {
    expect(formatAcceptDescription('constructor')).toBe('constructor');
  });
});

describe('a bar chart whose category key is constructor', () => {
  test('reports the missing key for a row that lacks it', () => {
    expect(() =>
      normalizeBarData(
        [{ label: 'a', value: 1 }],
        'constructor',
        [{ id: 'value', label: 'Value', valueKey: 'value' }],
        [],
      ),
    ).toThrow(/category key is missing/);
  });
});
