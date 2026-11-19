/**
 * The per-row verdict check (`scripts/design-review-rows.ts`): a design review must answer every row
 * it was given, once, in order, with a verdict its mode allows and evidence for anything that is not
 * a match, because the chef close gate and the design ledger read the file as the review's result.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedRows } from '../../../scripts/chef/design-rows-resolved.ts';
import {
  captureManifest,
  checkRowFiles,
  checkVerdicts,
  describeMissing,
  MAXIMUM_EVIDENCE_LENGTH,
  missingCaptures,
  overallVerdict,
  OWNER_RULE_ROWS,
  parseArguments,
  parseCaptureManifest,
  parseRows,
  type DesignRow,
} from './design-review-rows.ts';

/** The owner-rule rows every review ends with, each holding, as verdict lines. */
const CHECKLIST = OWNER_RULE_ROWS.map(({ id }) => `${id} | matches |`);

/** `lines` with the owner-rule rows after them, as a complete review writes its verdicts. */
const complete = (...lines: string[]): string => [...lines, ...CHECKLIST].join('\n');

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
      complete(
        '11a | matches |',
        '11b | drifted | screens/chats--1280--light.png; src/routes/chat/header.svelte:40; delete sits outside the menu',
        '23j | deferred | COR-1967 defers the effort control to the composer issue',
      ),
      'implementation-review',
    );
    expect(check.problems).toEqual([]);
    expect(check.counts.matches).toBe(1 + OWNER_RULE_ROWS.length);
    expect(check.counts.drifted).toBe(1);
    expect(overallVerdict(check.counts)).toBe('changes required');
  });

  test('fails a missing row, a row out of order and an unknown verdict', () => {
    const check = checkVerdicts(
      rows(),
      complete('11b | matches |', '11a | fine | looks good').split('\n').slice(0, 2).join('\n'),
      'implementation-review',
    );
    expect(check.problems).toEqual([
      'expected 10 verdict lines, one per row (3) and one per owner rule (7), got 2',
      'verdicts line 1: expected row 11a, got 11b',
      'verdicts line 2: expected row 11b, got 11a',
      'verdicts line 2: "fine" is not one of matches, drifted, partial, missing, superseded, deferred, unverified',
      ...OWNER_RULE_ROWS.map(({ id }) => `owner-rule row ${id} is missing from the verdicts`),
    ]);
  });

  test('rejects a verdict that omits an owner-rules checklist row', () => {
    const answered = ['11a | matches |', '11b | matches |', '23j | matches |'];
    for (const [index, { id }] of OWNER_RULE_ROWS.entries()) {
      const without = [...answered, ...CHECKLIST.filter((_, position) => position !== index)];
      const check = checkVerdicts(rows(), without.join('\n'), 'implementation-review');
      expect(check.problems[0]).toBe(
        'expected 10 verdict lines, one per row (3) and one per owner rule (7), got 9',
      );
      expect(check.problems).toContain(`owner-rule row ${id} is missing from the verdicts`);
    }
    expect(checkVerdicts(rows(), answered.join('\n'), 'drift-audit').problems[0]).toContain(
      'got 3',
    );
  });

  test('holds an owner rule to matches, drifted or unverified, and refuses it as a row of the issue', () => {
    const check = checkVerdicts(
      rows(),
      [
        '11a | matches |',
        '11b | matches |',
        '23j | matches |',
        'rule-middle-dots | deferred | COR-1',
        ...CHECKLIST.slice(1),
      ].join('\n'),
      'implementation-review',
    );
    expect(check.problems).toEqual([
      'verdicts line 4: owner rule rule-middle-dots takes matches, drifted, unverified, not deferred',
    ]);
    expect(parseRows('rule-middle-dots | chat | no dots')).toEqual({
      ok: false,
      problems: ['rows line 1: rule-middle-dots is an owner-rule row, which every review adds'],
    });
  });

  test('keeps superseded to a drift audit, deferred to an implementation review, and demands evidence', () => {
    const verdicts = complete(
      '11a | superseded | row 11c',
      '11b | deferred | COR-1968',
      '23j | missing |',
    );
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
      complete(
        '11a | matches |',
        '11b | matches |',
        '23j | unverified | no capture opens the composer',
      ),
      'implementation-review',
    );
    expect(check.problems).toEqual([]);
    expect(overallVerdict(check.counts)).toBe('changes required');
  });
});

describe('the evidence limit and the line shape', () => {
  test('fails evidence longer than the limit and accepts evidence at it', () => {
    const verdicts = (evidence: string) =>
      complete('11a | matches |', `11b | drifted | ${evidence}`, '23j | matches |');
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
      complete('11a | matches |', '11b | drifted', '23j | matches |'),
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
        complete('11a | matches |', '11b | matches |', '23j | deferred | COR-1967'),
      ),
    ).toBe(0);
    expect(output).toBe('design review rows: matches 9, deferred 1\nVERDICT: approve\n');
    expect(errors).toBe('');
  });

  test('answers 0 without a verdict for a drift audit', async () => {
    expect(
      await check('drift-audit', complete('11a | matches |', '11b | matches |', '23j | matches |')),
    ).toBe(0);
    expect(output).toBe('design review rows: matches 10\n');
  });

  test('answers 1 with the summary and every problem when the verdicts are wrong', async () => {
    expect(await check('implementation-review', '')).toBe(1);
    expect(output).toBe('design review rows: no verdicts\n');
    expect(errors).toBe(
      [
        'expected 10 verdict lines, one per row (3) and one per owner rule (7), got 0',
        ...OWNER_RULE_ROWS.map(({ id }) => `owner-rule row ${id} is missing from the verdicts`),
      ].join('\n') + '\n',
    );
  });

  test('answers 1 for a verdicts file that leaves out the owner-rule rows', async () => {
    expect(
      await check('implementation-review', '11a | matches |\n11b | matches |\n23j | matches |'),
    ).toBe(1);
    expect(errors).toContain('one per owner rule (7), got 3');
  });

  test('prints the owner-rule template, which fails the check until it is filled in', async () => {
    expect(await checkRowFiles(['--checklist'], streams)).toBe(0);
    for (const { id } of OWNER_RULE_ROWS)
      expect(output).toContain(`${id} | <verdict> | <evidence>`);
    const template = [
      '11a | matches |',
      '11b | matches |',
      '23j | matches |',
      ...output.split('\n'),
    ].join('\n');
    output = '';
    errors = '';
    expect(await check('implementation-review', template)).toBe(1);
    expect(errors).toContain('"<verdict>" is not one of');
  });
});

describe('captureManifest', () => {
  const resolved: ResolvedRows = {
    version: 1,
    issue: 'COR-9',
    rows: [
      {
        id: '11a',
        board: 'Runs',
        text: 'Runs list',
        states: [
          { route: '/runs', state: 'ready', kind: 'ready' },
          { route: '/runs', state: 'empty', kind: 'empty' },
        ],
      },
      {
        id: '12a',
        board: 'Home',
        text: 'Home on a fresh installation',
        states: [{ route: '/', state: 'first run fresh installation', kind: 'first-run' }],
        widths: [1920, 1280, 375],
        themes: ['light'],
      },
    ],
    checked: [],
    conflicts: [],
  };

  test('names every declared state at every width and theme, including 1920 and first-run', () => {
    const { captures } = captureManifest(resolved);
    // 11a: two states, four default widths, two themes; 12a: one state, three widths, one theme.
    expect(captures).toHaveLength(2 * 4 * 2 + 1 * 3 * 1);
    const names = (row: string) =>
      new Set(
        captures
          .filter((entry) => entry.row === row)
          .map((entry) => `${entry.route}|${entry.state}|${entry.width}|${entry.theme}`),
      );
    for (const state of ['ready', 'empty'])
      for (const width of [1920, 1280, 768, 375])
        for (const theme of ['light', 'dark'])
          expect(names('11a')).toContain(`/runs|${state}|${width}|${theme}`);
    expect(names('12a')).toContain('/|first run fresh installation|1920|light');
    expect(captures.some((entry) => entry.kind === 'first-run' && entry.width === 1920)).toBe(true);
  });

  test('orders the whole manifest widest width first, light before dark', () => {
    const { captures } = captureManifest(resolved);
    const widths = captures.map((entry) => entry.width);
    expect(widths).toEqual(widths.toSorted((left, right) => right - left));
    expect(captures[0]?.width).toBe(1920);
    expect(captures[0]?.theme).toBe('light');
    const firstDark = captures.findIndex((entry) => entry.theme === 'dark' && entry.width === 1920);
    const lastLight = captures.findLastIndex(
      (entry) => entry.theme === 'light' && entry.width === 1920,
    );
    expect(firstDark).toBeGreaterThan(lastLight);
  });

  test('narrows to the rows named by --only', () => {
    expect(new Set(captureManifest(resolved, ['12a']).captures.map((entry) => entry.row))).toEqual(
      new Set(['12a']),
    );
  });

  test('missingCaptures names an expected capture no manifest line shows, and describes it', () => {
    const { captures } = captureManifest(resolved, ['12a']);
    const shown = [
      { route: '/', state: 'first run fresh installation', width: 1280, colorScheme: 'light' },
      { route: '/', state: 'first run fresh installation', width: 375, colorScheme: 'light' },
    ];
    const missing = missingCaptures(captures, shown);
    expect(missing.map((entry) => entry.width)).toEqual([1920]);
    expect(describeMissing(missing[0]!)).toBe(
      'missing capture: route /, state "first run fresh installation" (first-run), width 1920, light, declared by row 12a',
    );
    expect(missingCaptures(captures, [...shown, { ...shown[0]!, width: 1920 }])).toEqual([]);
  });

  test('parseCaptureManifest reads what captureManifest writes and refuses the rest', () => {
    expect(parseCaptureManifest(JSON.stringify(captureManifest(resolved)))).toEqual(
      captureManifest(resolved),
    );
    expect(parseCaptureManifest('{')).toBe('the capture manifest is not JSON');
    expect(parseCaptureManifest('{"version":2}')).toBe(
      'the capture manifest needs version 1 and a captures list',
    );
    expect(parseCaptureManifest('{"version":1,"issue":"COR-9","captures":[]}')).toBe(
      'the capture manifest expects no captures',
    );
  });
});

describe('--manifest', () => {
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
    directory = await mkdtemp(join(tmpdir(), 'design-review-manifest-'));
    output = '';
    errors = '';
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const resolvedFile = (rows: unknown[]) =>
    JSON.stringify({ version: 1, issue: 'COR-9', rows, checked: [], conflicts: [] });

  test('writes the expected captures, widest first, widths defaulting to include 1920', async () => {
    const path = join(directory, 'rows.resolved.json');
    await writeFile(
      path,
      resolvedFile([
        {
          id: '11a',
          board: 'Runs',
          text: 'x',
          states: [{ route: '/runs', state: 'ready', kind: 'ready' }],
        },
      ]),
    );
    const out = join(directory, 'expected.json');
    expect(await checkRowFiles(['--manifest', path, '--out', out], streams)).toBe(0);
    const written = JSON.parse(await Bun.file(out).text()) as { captures: { width: number }[] };
    expect(written.captures[0]?.width).toBe(1920);
    expect(output).toContain('8 expected captures');
  });

  test('exits 1 for an --only that names no row, since an empty plan is covered by anything', async () => {
    const path = join(directory, 'rows.resolved.json');
    await writeFile(
      path,
      resolvedFile([
        {
          id: '11a',
          board: 'Runs',
          text: 'x',
          states: [{ route: '/runs', state: 'ready', kind: 'ready' }],
        },
      ]),
    );
    expect(await checkRowFiles(['--manifest', path, '--only', '99z'], streams)).toBe(1);
    expect(errors).toContain('--only names no row of COR-9: 99z');
    expect(output).toBe('');
  });

  test('exits 1 for a row that declares no states', async () => {
    const path = join(directory, 'rows.resolved.json');
    await writeFile(path, resolvedFile([{ id: '11a', board: 'Runs', text: 'x', states: [] }]));
    expect(await checkRowFiles(['--manifest', path], streams)).toBe(1);
    expect(errors).toContain('row 11a declares no states');
  });
});
