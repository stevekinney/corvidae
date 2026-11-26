/**
 * The coverage ledger check (`design-coverage.ts`). A design review approved milestone 2 of the
 * Temporal UI without opening `executions-typed-filter-open`, with one sentence of cold judgement for
 * six pages, and with no look at section rhythm, grouping, column widths or labels; the owner then
 * found eight defects, seven of them in captures the review had. These fixtures are shaped like that
 * miss, so the check has to name each gap.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  checkLedger,
  run,
  SWEEP_CATEGORIES,
  UsageError,
  viewportCaptures,
} from './design-coverage.ts';

const SCREENS = [
  'screens/executions--default--1280--light.png',
  'screens/executions-typed-filter-open--1280--light.png',
  'screens/project-status--1280--light.png',
];

function withCapture(
  body: (directory: string) => void,
  screens: readonly string[] = SCREENS,
): void {
  const directory = mkdtempSync(join(tmpdir(), 'design-coverage-'));
  try {
    for (const screen of [...screens, 'screens/executions--default--1280--light.full.png']) {
      mkdirSync(dirname(join(directory, screen)), { recursive: true });
      writeFileSync(join(directory, screen), '');
    }
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const SWEEP = SWEEP_CATEGORIES.map(
  (category) => `sweep | ${category} | clear | checked on every screen in the ledger above`,
);

function ledger(screenLines: readonly string[], extra: readonly string[] = SWEEP): string {
  return [...screenLines, ...extra].join('\n');
}

const FULL = [
  `screen | ${SCREENS[0]} | good | The list leads with its runs and the filters sit open above it.`,
  `screen | ${SCREENS[1]} | good | The open filter reads as one form with its action directly under it.`,
  `screen | ${SCREENS[2]} | good | Each section is one step apart and the table columns fit their content.`,
];

describe('design coverage ledger', () => {
  test('lists the viewport captures and leaves out full-page ones', () => {
    withCapture((directory) => {
      expect(viewportCaptures(directory)).toEqual([...SCREENS].toSorted());
    });
  });

  test('a complete ledger with every screen judged good allows approval', () => {
    withCapture((directory) => {
      const result = checkLedger(directory, ledger(FULL));
      expect(result.problems).toEqual([]);
      expect(result.blocking).toEqual([]);
    });
  });

  test('names a capture the review never judged, such as the typed filter left open', () => {
    withCapture((directory) => {
      const result = checkLedger(directory, ledger([FULL[0]!, FULL[2]!]));
      expect(result.problems).toContain(
        `no cold verdict for ${SCREENS[1]}: open it and judge it before any comparison`,
      );
    });
  });

  test('refuses one sentence of judgement reused across screens', () => {
    withCapture((directory) => {
      const sentence = 'Overall, judged cold, these pages are good and follow the design.';
      const result = checkLedger(
        directory,
        ledger(SCREENS.map((screen) => `screen | ${screen} | good | ${sentence}`)),
      );
      expect(result.problems.some((problem) => problem.includes('repeats the verdict'))).toBe(true);
    });
  });

  test('refuses a verdict too short to say what the screen does', () => {
    withCapture((directory) => {
      const result = checkLedger(
        directory,
        ledger([FULL[0]!, FULL[1]!, `screen | ${SCREENS[2]} | good | Looks fine.`]),
      );
      expect(result.problems.some((problem) => problem.includes('at least'))).toBe(true);
    });
  });

  test('names each sweep category the review did not answer', () => {
    withCapture((directory) => {
      const result = checkLedger(directory, ledger(FULL, SWEEP.slice(1)));
      expect(result.problems).toContain(`sweep category ${SWEEP_CATEGORIES[0]} is not answered`);
    });
  });

  test("a ledger concatenated from two area dispatches keeps each area's sweep lines", () => {
    withCapture((directory) => {
      const areaOne = ledger([FULL[0]!, FULL[1]!]);
      const areaTwo = ledger(
        [FULL[2]!],
        SWEEP.map((line, index) =>
          index === 0
            ? `sweep | ${SWEEP_CATEGORIES[0]} | found | toggle sits apart from its explanation`
            : line,
        ),
      );
      const result = checkLedger(directory, `${areaOne}\n${areaTwo}`);
      expect(result.problems).toEqual([]);
      expect(result.blocking).toEqual([`sweep ${SWEEP_CATEGORIES[0]}: found`]);
    });
  });

  test('refuses a screen line for a file that is not in the capture', () => {
    withCapture((directory) => {
      const result = checkLedger(
        directory,
        ledger([
          ...FULL,
          'screen | screens/elsewhere.png | good | A screen from another run entirely.',
        ]),
      );
      expect(result.problems).toContain('screens/elsewhere.png is not a viewport capture here');
    });
  });

  test('a wrong or unsure screen, a found sweep, or an uncaptured state blocks approval', () => {
    withCapture((directory) => {
      const wrong = `screen | ${SCREENS[1]} | wrong | The badge and caption float below the button label in the last row.`;
      const unsure = `screen | ${SCREENS[2]} | unsure | The sections may be too far apart; show the owner both gaps.`;
      const found = SWEEP.map((line, index) =>
        index === 0
          ? line.replace(
              '| clear | checked on every screen in the ledger above',
              '| found | toggle sits apart from its explanation',
            )
          : line,
      );
      const result = checkLedger(
        directory,
        ledger([FULL[0]!, wrong, unsure], [...found, 'state | the run menu opened | not captured']),
      );
      expect(result.problems).toEqual([]);
      expect(result.blocking).toEqual([
        `${SCREENS[1]}: wrong`,
        `${SCREENS[2]}: unsure, show the owner`,
        `sweep ${SWEEP_CATEGORIES[0]}: found`,
        'state the run menu opened: not captured',
      ]);
    });
  });

  test('a one-click state names a capture that exists', () => {
    withCapture((directory) => {
      const result = checkLedger(
        directory,
        ledger(FULL, [...SWEEP, 'state | the typed filter opened | screens/missing.png']),
      );
      expect(result.problems).toContain(
        'state the typed filter opened names screens/missing.png, which is not a viewport capture here',
      );
    });
  });

  test('the command exits 1 on gaps, 3 when complete but blocking, and 0 when approvable', () => {
    withCapture((directory) => {
      const path = join(directory, 'coverage-ledger.txt');
      writeFileSync(path, ledger([FULL[0]!]));
      expect(run(['check', '--capture', directory, '--ledger', path]).code).toBe(1);
      writeFileSync(path, ledger(FULL, [...SWEEP, 'state | the run menu opened | not captured']));
      expect(run(['check', '--capture', directory, '--ledger', path]).code).toBe(3);
      writeFileSync(path, ledger(FULL));
      const passing = run(['check', '--capture', directory, '--ledger', path]);
      expect(passing.code).toBe(0);
      expect(passing.output).toContain('3 screens judged');
    });
  });

  test('a capture with no viewport images is not a review', () => {
    withCapture((directory) => {
      expect(checkLedger(directory, ledger([])).problems).toContain(
        'the capture has no viewport images to judge',
      );
    }, []);
  });

  test('needs the check command, a capture and a ledger', () => {
    expect(() => run(['record'])).toThrow(UsageError);
    expect(() => run(['check', '--capture', 'x'])).toThrow(UsageError);
  });
});
