import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_WIDTHS,
  literalCriteria,
  validateResolved,
  type ResolvedRows,
} from './design-rows-resolved.ts';

const expected = { issue: 'COR-2444', rowIds: ['11a', '12a'], literals: ['700px'] };

function state(route: string, name: string, kind: 'ready' | 'empty' | 'first-run') {
  return {
    route,
    state: name,
    kind,
    witness: {
      specification: 'tests/e2e/runs-states.spec.ts',
      title: `/runs ${name} at 375 pixels`,
      world: 'sample-world',
      profiles: [
        {
          name: 'phone-light',
          width: 375,
          theme: 'light' as const,
          targets: ['runs-list'],
          visible: 'The runs list and its actions are visible without scrolling.',
          scrolling: 'none' as const,
        },
      ],
    },
  };
}

function resolved(overrides: Partial<ResolvedRows> = {}): ResolvedRows {
  return {
    version: 2,
    issue: 'COR-2444',
    rows: [
      {
        id: '11a',
        board: 'Runs',
        text: 'The run list reads as cards below 700px',
        states: [state('/runs', 'ready', 'ready'), state('/runs', 'empty', 'empty')],
      },
      {
        id: '12a',
        board: 'Home',
        text: 'Home on a fresh installation',
        states: [state('/', 'first run fresh installation', 'first-run')],
      },
    ],
    checked: [{ literal: '700px', result: 'consistent' }],
    conflicts: [],
    ...overrides,
  };
}

describe('literalCriteria', () => {
  test('finds each literal pixel threshold once, normalised', () => {
    expect(literalCriteria('Below 700 px the list collapses; at 700px and 48px it stays.')).toEqual(
      ['700px', '48px'],
    );
    expect(literalCriteria('no numbers here')).toEqual([]);
  });
});

describe('validateResolved', () => {
  test('accepts a file that declares states for every row and accounts for every literal', () => {
    expect(validateResolved(resolved(), expected)).toEqual([]);
    expect(DEFAULT_WIDTHS[0]).toBe(1920);
  });

  test('refuses a file that is not an object of the right issue and version', () => {
    expect(validateResolved('nope', expected)).toEqual(['rows.resolved.json is not an object']);
    expect(validateResolved(resolved({ issue: 'COR-1' }), expected).join()).toContain(
      'is for COR-1, not COR-2444',
    );
    expect(validateResolved({ ...resolved(), version: 1 }, expected).join()).toContain('version');
  });

  test('refuses a row with no declared states, a row left out and an unknown row', () => {
    const base = resolved();
    const noStates = { ...base, rows: [{ ...base.rows[0]!, states: [] }, base.rows[1]!] };
    expect(validateResolved(noStates, expected).join()).toContain('row 11a declares no states');
    const missing = { ...base, rows: [base.rows[0]!] };
    expect(validateResolved(missing, expected).join()).toContain('row 12a has no entry');
    const unknown = { ...base, rows: [...base.rows, { ...base.rows[0]!, id: '99z' }] };
    expect(validateResolved(unknown, expected).join()).toContain(
      'row 99z is not a row of COR-2444',
    );
  });

  test('requires explicit widths to include 1920, 1280 and a phone width', () => {
    const base = resolved();
    const narrow = {
      ...base,
      rows: [{ ...base.rows[0]!, widths: [1280, 375] }, base.rows[1]!],
    };
    expect(validateResolved(narrow, expected).join()).toContain('row 11a widths lack 1920');
    const noPhone = {
      ...base,
      rows: [{ ...base.rows[0]!, widths: [1920, 1280] }, base.rows[1]!],
    };
    expect(validateResolved(noPhone, expected).join()).toContain('lack a phone width');
  });

  test('requires a literal Playwright state and safe physical viewport profiles', () => {
    const base = resolved();
    const state = base.rows[0]!.states[0]!;
    const malformed = {
      ...base,
      rows: [
        {
          ...base.rows[0]!,
          states: [
            {
              ...state,
              witness: {
                ...state.witness,
                specification: 'bun test anything',
                profiles: [{ ...state.witness.profiles[0]!, targets: ['[data-anything]'] }],
              },
            },
          ],
        },
        base.rows[1]!,
      ],
    };
    const problems = validateResolved(malformed, expected).join('\n');
    expect(problems).toContain('repository-relative Playwright specification');
    expect(problems).toContain('named data-testid or role targets');
  });

  test('requires every literal criterion of the issue to be checked, and a conflict to be settled with a reason', () => {
    expect(validateResolved(resolved({ checked: [] }), expected).join()).toContain(
      'literal criterion 700px was not checked',
    );
    const unsettled = resolved({
      checked: [{ literal: '700px', result: 'conflict' }],
      conflicts: [],
    });
    expect(validateResolved(unsettled, expected).join()).toContain(
      'literal criterion 700px conflicts with a row but no conflict records it',
    );
    const noReason = resolved({
      checked: [{ literal: '700px', result: 'conflict' }],
      conflicts: [
        { criterion: 'collapse below 700px', rows: ['11a'], resolution: 'decision', reason: ' ' },
      ],
    });
    expect(validateResolved(noReason, expected).join()).toContain('needs a reason');
    const settled = resolved({
      checked: [{ literal: '700px', result: 'conflict' }],
      conflicts: [
        {
          criterion: 'collapse below 700px',
          rows: ['11a'],
          resolution: 'deferral',
          reason: 'the board draws cards at 640px; the owner decides',
        },
      ],
    });
    expect(validateResolved(settled, expected)).toEqual([]);
  });
});
