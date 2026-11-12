/**
 * The per-row verdict check (`scripts/design-review-rows.ts`): a design review must answer every row
 * it was given, once, in order, with a verdict its mode allows and evidence for anything that is not
 * a match, because the chef close gate and the design ledger read the file as the review's result.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkRowFiles,
  checkVerdicts,
  MAXIMUM_EVIDENCE_LENGTH,
  overallVerdict,
  parseArguments,
  parseRows,
  type DesignRow,
} from './design-review-rows.ts';

const ROWS_TEXT = [
  '11a | chat-header | The header shows the agent and its model',
  '11b | chat-header | The More menu holds rename / delete',
  '23j | composer | Effort sits beside the model picker',
].join('\n');

function rows(): readonly DesignRow[] {
  const parsed = parseRows(ROWS_TEXT);
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
  return parsed.rows;
}

describe('parseRows', () => {
  test('reads id, board and text, keeping a pipe inside the text', () => {
    const parsed = parseRows('08e | settings | Labels | use the formatter');
    expect(parsed).toEqual({
      ok: true,
      rows: [{ id: '08e', board: 'settings', text: 'Labels / use the formatter' }],
    });
  });

  test('refuses a row that states only what was wrong, and keeps one that says what should be true first', () => {
    const defect = parseRows('A5 | Chat | Was: action rows float 35px under the text');
    expect(defect.ok).toBe(false);
    if (!defect.ok) expect(defect.problems[0]).toContain('row A5 states only what was wrong');
    const outcome = parseRows(
      'A5 | Chat | An action row sits at most 8px under its message. Was: it floated 35px under.',
    );
    expect(outcome.ok).toBe(true);
  });

  test('refuses a line without a board and a row named twice', () => {
    const parsed = parseRows('11a | chat-header | one\n11a | chat-header | two\nbroken');
    expect(parsed).toEqual({
      ok: false,
      problems: [
        'rows line 2: row 11a appears twice',
        'rows line 3: expected "row-id | board | text", got "broken"',
      ],
    });
  });
});

describe('checkVerdicts', () => {
  test('passes one well-formed verdict per row and counts them', () => {
    const check = checkVerdicts(
      rows(),
      [
        '11a | matches |',
        '11b | drifted | screens/chats--1280--light.png; src/routes/chat/header.svelte:40; delete sits outside the menu',
        '23j | deferred | COR-1967 defers the effort control to the composer issue',
      ].join('\n'),
      'implementation-review',
    );
    expect(check.problems).toEqual([]);
    expect(check.counts.matches).toBe(1);
    expect(check.counts.drifted).toBe(1);
    expect(overallVerdict(check.counts)).toBe('changes required');
  });

  test('fails a missing row, a row out of order and an unknown verdict', () => {
    const check = checkVerdicts(
      rows(),
      ['11b | matches |', '11a | fine | looks good'].join('\n'),
      'implementation-review',
    );
    expect(check.problems).toEqual([
      'expected 3 verdict lines, one per row, got 2',
      'verdicts line 1: expected row 11a, got 11b',
      'verdicts line 2: expected row 11b, got 11a',
      'verdicts line 2: "fine" is not one of matches, drifted, partial, missing, superseded, deferred, unverified',
    ]);
  });

  test('keeps superseded to a drift audit, deferred to an implementation review, and demands evidence', () => {
    const verdicts = [
      '11a | superseded | row 11c',
      '11b | deferred | COR-1968',
      '23j | missing |',
    ].join('\n');
    expect(checkVerdicts(rows(), verdicts, 'implementation-review').problems).toEqual([
      'verdicts line 1: superseded belongs to a drift audit only',
      'verdicts line 3: missing needs evidence',
    ]);
    expect(checkVerdicts(rows(), verdicts, 'drift-audit').problems).toEqual([
      'verdicts line 2: deferred belongs to an implementation review only',
      'verdicts line 3: missing needs evidence',
    ]);
  });

  test('treats an unverified row as a failure, never a pass', () => {
    const check = checkVerdicts(
      rows(),
      [
        '11a | matches |',
        '11b | matches |',
        '23j | unverified | no capture opens the composer',
      ].join('\n'),
      'implementation-review',
    );
    expect(check.problems).toEqual([]);
    expect(overallVerdict(check.counts)).toBe('changes required');
  });
});

describe('the evidence limit and the line shape', () => {
  test('fails evidence longer than the limit and accepts evidence at it', () => {
    const verdicts = (evidence: string) =>
      ['11a | matches |', `11b | drifted | ${evidence}`, '23j | matches |'].join('\n');
    const long = 'e'.repeat(MAXIMUM_EVIDENCE_LENGTH + 1);
    expect(checkVerdicts(rows(), verdicts(long), 'implementation-review').problems).toEqual([
      `verdicts line 2: evidence is longer than ${MAXIMUM_EVIDENCE_LENGTH} characters`,
    ]);
    expect(
      checkVerdicts(rows(), verdicts(long.slice(1)), 'implementation-review').problems,
    ).toEqual([]);
  });

  test('fails a verdict line that is not three fields', () => {
    const check = checkVerdicts(
      rows(),
      ['11a | matches |', '11b | drifted', '23j | matches |'].join('\n'),
      'implementation-review',
    );
    expect(check.problems).toEqual([
      'verdicts line 2: expected "row-id | verdict | evidence", got "11b | drifted"',
    ]);
  });
});

describe('parseArguments', () => {
  test('reads the mode and both files, and refuses the rest', () => {
    expect(
      parseArguments(['--mode', 'drift-audit', '--rows', 'r.txt', '--verdicts', 'v.txt']),
    ).toEqual({ mode: 'drift-audit', rows: 'r.txt', verdicts: 'v.txt' });
    expect(parseArguments(['--mode', 'sweep', '--rows', 'r', '--verdicts', 'v'])).toBe(
      '--mode must be implementation-review or drift-audit',
    );
    expect(parseArguments(['--mode', 'drift-audit', '--rows', 'r'])).toBe(
      '--rows and --verdicts are required',
    );
    expect(parseArguments(['--color', 'x'])).toBe('unknown flag --color');
  });
});

describe('checkRowFiles', () => {
  let directory = '';
  let output = '';
  let errors = '';
  const streams = {
    standardOutput: (text: string) => {
      output += text;
    },
    standardError: (text: string) => {
      errors += text;
    },
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'design-review-rows-'));
    output = '';
    errors = '';
    await writeFile(join(directory, 'rows.txt'), ROWS_TEXT);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function check(mode: string, verdicts: string): Promise<number> {
    await writeFile(join(directory, 'verdicts.txt'), verdicts);
    return checkRowFiles(
      [
        '--mode',
        mode,
        '--rows',
        join(directory, 'rows.txt'),
        '--verdicts',
        join(directory, 'verdicts.txt'),
      ],
      streams,
    );
  }

  test('answers 2 and prints the usage error for a bad command line', async () => {
    expect(await checkRowFiles(['--mode', 'sweep'], streams)).toBe(2);
    expect(errors).toBe('--mode must be implementation-review or drift-audit\n');
    expect(output).toBe('');
  });

  test('answers 1 and names each problem in an unreadable rows file', async () => {
    await writeFile(join(directory, 'rows.txt'), 'broken');
    expect(await check('drift-audit', '')).toBe(1);
    expect(errors).toBe('rows line 1: expected "row-id | board | text", got "broken"\n');
  });

  test('answers 0 and the derived verdict for a well-formed implementation review', async () => {
    expect(
      await check(
        'implementation-review',
        ['11a | matches |', '11b | matches |', '23j | deferred | COR-1967'].join('\n'),
      ),
    ).toBe(0);
    expect(output).toBe('design review rows: matches 2, deferred 1\nVERDICT: approve\n');
    expect(errors).toBe('');
  });

  test('answers 0 without a verdict for a drift audit', async () => {
    expect(
      await check(
        'drift-audit',
        ['11a | matches |', '11b | matches |', '23j | matches |'].join('\n'),
      ),
    ).toBe(0);
    expect(output).toBe('design review rows: matches 3\n');
  });

  test('answers 1 with the summary and every problem when the verdicts are wrong', async () => {
    expect(await check('implementation-review', '')).toBe(1);
    expect(output).toBe('design review rows: no verdicts\n');
    expect(errors).toBe('expected 3 verdict lines, one per row, got 0\n');
  });
});
