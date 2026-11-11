import { describe, expect, it } from 'bun:test';

import casesData from '../src/fixtures/chat-stress.json';
import { parseStressCases, type StressCase } from '../src/fixtures/chat-stress/stress-cases.ts';
import {
  COMPOSER_EDGE_TOLERANCE,
  STRESS_PROFILES,
  SUPPLEMENTAL_PROFILE,
  composerEdgeProblems,
  countProblems,
  escapeHtml,
  expectedCounts,
  focusVariantName,
  galleryImageFiles,
  measurementProblems,
  primaryImageName,
  profilesFor,
  reconciliationProblems,
  renderGallery,
  selectCases,
  sourceIdentity,
  variantImageName,
  type CaptureRecord,
  type PageMeasurement,
  type RunSummary,
} from './chat-stress-plan.ts';

const cases = parseStressCases(casesData);
const [wide, tablet, phone, narrow] = STRESS_PROFILES;
if (wide === undefined || tablet === undefined || phone === undefined || narrow === undefined) {
  throw new Error('The four stress profiles are missing.');
}

function caseNumbered(id: number): StressCase {
  const found = cases.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Case ${id} is missing.`);
  return found;
}

const CLEAN: PageMeasurement = {
  pageErrors: [],
  documentWidth: { scroll: 320, client: 320 },
  smallTargets: [],
  clippedStatuses: [],
  directions: [],
  composerEdge: 600,
};

describe('profiles', () => {
  it('are the four of the board, with touch below 500 px', () => {
    expect(STRESS_PROFILES.map((profile) => profile.name)).toEqual([
      '1440-light',
      '768-dark',
      '390-light',
      '320-dark',
    ]);
    expect(
      STRESS_PROFILES.filter((profile) => profile.coarse).map((profile) => profile.width),
    ).toEqual([390, 320]);
    for (const profile of STRESS_PROFILES) expect(profile.coarse).toBe(profile.width < 500);
  });

  it('add the 390 dark phone profile only for a supplemental run', () => {
    expect(profilesFor(false)).toHaveLength(4);
    expect(profilesFor(true).at(-1)).toBe(SUPPLEMENTAL_PROFILE);
    expect(SUPPLEMENTAL_PROFILE.coarse).toBe(true);
  });
});

describe('image names', () => {
  it('write <width>-<theme>-<case>.png for a primary with a two digit case', () => {
    expect(primaryImageName(narrow, 24)).toBe('320-dark-24.png');
    expect(primaryImageName(wide, 9)).toBe('1440-light-09.png');
  });

  it('write <width>-<theme>-<case>-<variant>.png for a variant', () => {
    expect(variantImageName(phone, 33, 'expanded')).toBe('390-light-33-expanded.png');
    expect(variantImageName(tablet, 73, focusVariantName(3))).toBe('768-dark-73-focus-3.png');
  });
});

describe('expectedCounts', () => {
  it('hold 320 primaries and 32 fixed variants before any focus image', () => {
    const counts = expectedCounts(cases, STRESS_PROFILES, {});
    expect(counts.primary).toBe(320);
    expect(counts.fixedVariants).toBe(32);
    expect(counts.focus).toBe(0);
    expect(counts.total).toBe(352);
  });

  it('add the focus stops each profile found', () => {
    const counts = expectedCounts(cases, STRESS_PROFILES, {
      '1440-light': 14,
      '768-dark': 14,
      '390-light': 13,
      '320-dark': 13,
    });
    expect(counts.focus).toBe(54);
    expect(counts.total).toBe(406);
  });
});

describe('measurementProblems', () => {
  it('passes a clean page', () => {
    expect(measurementProblems(CLEAN, narrow, caseNumbered(1))).toEqual([]);
  });

  it('names a page error and a document overflow', () => {
    const problems = measurementProblems(
      {
        ...CLEAN,
        pageErrors: ['TypeError: x is undefined'],
        documentWidth: { scroll: 412, client: 320 },
      },
      narrow,
      caseNumbered(1),
    );
    expect(problems).toEqual([
      'page error: TypeError: x is undefined',
      'document overflow: 412 px of content in 320 px',
    ]);
  });

  it('flags a short touch target at a coarse profile and not at a fine one', () => {
    const small = { ...CLEAN, smallTargets: [{ name: 'Remove', width: 28, height: 28 }] };
    expect(measurementProblems(small, narrow, caseNumbered(1))).toHaveLength(1);
    expect(measurementProblems(small, wide, caseNumbered(1))).toEqual([]);
  });

  it('flags clipped status text', () => {
    const clipped = { ...CLEAN, clippedStatuses: ['Waiting for approval'] };
    expect(measurementProblems(clipped, narrow, caseNumbered(24))).toEqual([
      'clipped status: Waiting for approval',
    ]);
  });

  it('flags a jump control that covers the transcript and a receipt that still waits', () => {
    expect(
      measurementProblems(
        { ...CLEAN, jumpOverlapsTranscript: true, approvalStillWaiting: true },
        narrow,
        caseNumbered(23),
      ),
    ).toEqual([
      'jump control overlaps the transcript',
      'approval still waits after its receipt appears',
    ]);
  });

  it('checks Arabic direction and alignment, and refuses a case that measured no text', () => {
    const rtl = caseNumbered(38);
    expect(measurementProblems(CLEAN, narrow, rtl)).toEqual(['no right-to-left text was measured']);
    const wrong = {
      ...CLEAN,
      directions: [{ text: 'استرداد', direction: 'ltr', textAlign: 'left' }],
    };
    expect(measurementProblems(wrong, narrow, rtl)).toEqual([
      'wrong direction: "استرداد" is ltr aligned left',
    ]);
    const right = {
      ...CLEAN,
      directions: [{ text: 'استرداد', direction: 'rtl', textAlign: 'start' }],
    };
    expect(measurementProblems(right, narrow, rtl)).toEqual([]);
  });

  it('checks the external approval receipt uses the available message width', () => {
    const receipt = caseNumbered(55);
    expect(measurementProblems({ ...CLEAN, approvalReceiptFits: false }, narrow, receipt)).toEqual([
      'the external approval receipt did not fill its message status slot',
    ]);
    expect(measurementProblems({ ...CLEAN, approvalReceiptFits: true }, narrow, receipt)).toEqual(
      [],
    );
  });

  it('requires exactly one announcement and a visible focus for the withdrawal of case 45', () => {
    const withdrawal = caseNumbered(45);
    expect(measurementProblems(CLEAN, narrow, withdrawal)).toEqual(['no withdrawal was measured']);
    expect(
      measurementProblems(
        { ...CLEAN, withdrawal: { announcements: 2, focusVisible: false } },
        narrow,
        withdrawal,
      ),
    ).toEqual(['withdrawal made 2 announcements, not one', 'withdrawal left no visible focus']);
    expect(
      measurementProblems(
        { ...CLEAN, withdrawal: { announcements: 1, focusVisible: true } },
        narrow,
        withdrawal,
      ),
    ).toEqual([]);
  });
});

describe('composerEdgeProblems', () => {
  it('accepts pairs whose edges match within the tolerance', () => {
    const edges = new Map<number, number | null>([
      [9, 600],
      [10, 600 + COMPOSER_EDGE_TOLERANCE],
      [14, 640],
      [15, 640],
    ]);
    expect(composerEdgeProblems(cases, wide, edges)).toEqual([]);
  });

  it('names a pair whose edge moved, once for the pair', () => {
    const edges = new Map<number, number | null>([
      [9, 600],
      [10, 572],
      [14, 640],
      [15, 640],
    ]);
    expect(composerEdgeProblems(cases, wide, edges)).toEqual([
      '1440-light: composer edge moved from 600 to 572 between cases 09 and 10',
    ]);
  });

  it('names a pair with no composer in one of its cases', () => {
    const edges = new Map<number, number | null>([
      [9, 600],
      [10, null],
    ]);
    expect(composerEdgeProblems(cases, wide, edges)).toEqual([
      '1440-light: composer edge missing in case 10',
    ]);
  });
});

function record(file: string, overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return { caseId: 1, profile: '1440-light', kind: 'primary', file, problems: [], ...overrides };
}

describe('reconciliationProblems', () => {
  const records = [record('a.png'), record('b.png', { kind: 'variant', variant: 'expanded' })];

  it('accepts a manifest, a directory and a gallery that agree', () => {
    expect(reconciliationProblems(records, ['a.png', 'b.png'], ['a.png', 'b.png'])).toEqual([]);
  });

  it('names an image the manifest lists that is missing from disk, and one on disk that it omits', () => {
    expect(reconciliationProblems(records, ['a.png', 'c.png'], ['a.png', 'b.png'])).toEqual([
      'the manifest names b.png, which is not on disk',
      'c.png is on disk but not in the manifest',
    ]);
  });

  it('names an image the gallery does not show', () => {
    expect(reconciliationProblems(records, ['a.png', 'b.png'], ['a.png'])).toEqual([
      'the gallery does not show b.png',
    ]);
  });

  it('names an image listed twice and a focus image with no control name', () => {
    expect(
      reconciliationProblems([record('a.png'), record('a.png')], ['a.png'], ['a.png']),
    ).toContain('the manifest names an image twice');
    const unnamed = record('f.png', {
      kind: 'focus',
      variant: 'focus-1',
      focus: { index: 1, name: '' },
    });
    expect(reconciliationProblems([unnamed], ['f.png'], ['f.png'])).toEqual([
      'f.png is a focus image with no control name',
    ]);
  });
});

describe('countProblems', () => {
  function completeRun(): CaptureRecord[] {
    const records: CaptureRecord[] = [];
    for (const profile of STRESS_PROFILES) {
      for (const stressCase of cases) {
        records.push(
          record(primaryImageName(profile, stressCase.id), {
            caseId: stressCase.id,
            profile: profile.name,
          }),
        );
        for (const variant of stressCase.variants) {
          records.push(
            record(variantImageName(profile, stressCase.id, variant.name), {
              caseId: stressCase.id,
              profile: profile.name,
              kind: 'variant',
              variant: variant.name,
            }),
          );
        }
      }
      records.push(
        record(variantImageName(profile, 73, focusVariantName(1)), {
          caseId: 73,
          profile: profile.name,
          kind: 'focus',
          variant: focusVariantName(1),
          focus: { index: 1, name: 'Message' },
        }),
      );
    }
    return records;
  }

  it('accepts a complete run', () => {
    expect(countProblems(completeRun(), cases, STRESS_PROFILES)).toEqual([]);
  });

  it('names a missing primary image', () => {
    const records = completeRun().filter((entry) => entry.file !== '320-dark-24.png');
    expect(countProblems(records, cases, STRESS_PROFILES)).toEqual([
      'expected 320 primary images, found 319',
    ]);
  });

  it('names a missing fixed variant', () => {
    const records = completeRun().filter((entry) => entry.file !== '390-light-33-expanded.png');
    expect(countProblems(records, cases, STRESS_PROFILES)).toEqual([
      'expected 32 fixed variant images, found 31',
    ]);
  });

  it('names a profile whose focus sweep found no control', () => {
    const records = completeRun().filter(
      (entry) => !(entry.kind === 'focus' && entry.profile === '768-dark'),
    );
    expect(countProblems(records, cases, STRESS_PROFILES)).toEqual([
      '768-dark: the focus sweep found no control',
    ]);
  });
});

describe('sourceIdentity', () => {
  const parts = { head: 'abc', changesDigest: 'one', buildDigest: 'two', bunVersion: '1.4.4' };

  it('is the same for the same source and different when any part differs', () => {
    expect(sourceIdentity(parts).identity).toBe(sourceIdentity({ ...parts }).identity);
    for (const key of ['head', 'changesDigest', 'buildDigest', 'bunVersion'] as const) {
      expect(sourceIdentity({ ...parts, [key]: 'changed' }).identity).not.toBe(
        sourceIdentity(parts).identity,
      );
    }
  });
});

describe('renderGallery', () => {
  const identity = sourceIdentity({
    head: 'abc',
    changesDigest: 'one',
    buildDigest: 'two',
    bunVersion: '1.4.4',
  });
  const counts = { primary: 1, fixedVariants: 0, focus: 0, total: 1 };

  function summary(overrides: Partial<RunSummary>): RunSummary {
    return {
      passed: true,
      complete: true,
      runDirectory: '/tmp/run',
      identity,
      cases: 80,
      profiles: ['1440-light'],
      counts,
      deferred: [],
      errors: [],
      ...overrides,
    };
  }

  it('shows every image of a case with its caption', () => {
    const html = renderGallery(
      [record('1440-light-55.png', { caseId: 55 })],
      [caseNumbered(55)],
      summary({}),
    );
    expect(galleryImageFiles(html)).toEqual(['1440-light-55.png']);
    expect(html).toContain('Chat stress gallery: Passed');
  });

  it('shows a deferred reason next to a case when one is supplied', () => {
    const html = renderGallery(
      [record('1440-light-55.png', { caseId: 55 })],
      [{ ...caseNumbered(55), deferred: 'The host must supply the decision.' }],
      summary({}),
    );
    expect(html).toContain('Deferred: The host must supply the decision.');
  });

  it('says Failed at the top and lists every error and the problem at its image', () => {
    const failing = record('1440-light-01.png', {
      problems: ['document overflow: 412 px of content in 320 px'],
    });
    const html = renderGallery(
      [failing],
      [caseNumbered(1)],
      summary({
        passed: false,
        errors: ['case 01 at 1440-light: document overflow: 412 px of content in 320 px'],
      }),
    );
    expect(html).toContain('Chat stress gallery: Failed');
    expect(html).toContain('<figure class="failed">');
    expect(html.match(/document overflow/g)).toHaveLength(2);
  });

  it('escapes text that would otherwise read as markup', () => {
    expect(escapeHtml('<b>"a" & \'b\'</b>')).toBe(
      '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;',
    );
  });
});

describe('selectCases', () => {
  it('keeps every case when nothing is selected', () => {
    expect(selectCases(cases, undefined)).toHaveLength(80);
    expect(selectCases(cases, ' ')).toHaveLength(80);
  });

  it('reads numbers and ranges, in case order', () => {
    expect(selectCases(cases, '15,9-10').map((stressCase) => stressCase.id)).toEqual([9, 10, 15]);
  });

  it('refuses a malformed part and a number that is not a case', () => {
    expect(() => selectCases(cases, '9,x')).toThrow("'x' is not a case number");
    expect(() => selectCases(cases, '81')).toThrow('Unknown case numbers: 81.');
  });

  it('marks a summary that did not draw every case as a partial run in its gallery', () => {
    const identity = sourceIdentity({
      head: 'a',
      changesDigest: 'b',
      buildDigest: 'c',
      bunVersion: '1',
    });
    const html = renderGallery([], [], {
      passed: true,
      complete: false,
      runDirectory: '/tmp/run',
      identity,
      cases: 2,
      profiles: ['1440-light'],
      counts: { primary: 2, fixedVariants: 0, focus: 0, total: 2 },
      deferred: [],
      errors: [],
    });
    expect(html).toContain('Chat stress gallery: Passed (partial run)');
  });
});
