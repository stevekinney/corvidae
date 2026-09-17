import type { DiffViewerMode } from '@repo/editor';
import type { DiffHunk } from '@repo/markdown';

// ---------------------------------------------------------------------------
// Instance A's document
// ---------------------------------------------------------------------------

// Front matter is here rather than on a separate fixture because DV-1 asks for
// it on the instance whose hunks are asserted, and because the interesting
// finding needs both halves of one document at once: `getHunks()` is BODY-ONLY
// (`groupIntoHunks(lineDiffs)`), while the stat badges sum body + front matter.
// A front-matter-only edit therefore reports changes in the toolbar and an
// empty hunk list — which you cannot observe on a document that has no front
// matter, or on one whose front matter never changes.
//
// A block sequence with two-space indentation is deliberate. The export
// pipeline shipped a corruption bug here: `normalize()` handed a whole
// document re-read the opening `---` as a thematic break and the YAML as a
// setext heading, injecting blank lines and flattening sequence indentation.
// `  - dana` is the line that goes wrong first when that regresses.
const FRONT_MATTER_LINES = [
  'title: Release Plan',
  'owner: platform',
  'reviewers:',
  '  - dana',
  '  - kit',
];

const frontMatter = (status: string) =>
  ['---', ...FRONT_MATTER_LINES, `status: ${status}`, '---'].join('\n');

// The body is written as an explicit line array, not as a prose blob, because
// every number the spec asserts is a LINE INDEX. Two changed regions, seven
// unchanged lines between them: `groupIntoHunks` merges two change ranges when
// they sit within `2 * CONTEXT_LINES` (6) of each other, so a shorter gap
// silently collapses this into one hunk and the "exactly two hunks" assertion
// starts asserting something weaker than it claims. The realised gap here is
// 12 line indices.
const BODY_LINES = [
  '# Release Plan',
  '',
  'The dashboard ships in the first wave.',
  'Exports follow one week later.',
  '',
  'Context line one.',
  'Context line two.',
  'Context line three.',
  'Context line four.',
  'Context line five.',
  'Context line six.',
  'Context line seven.',
  '',
  'The migration script is untested.',
  'Timeline risk is high.',
];

const FIRST_WAVE = 'The dashboard ships in the first wave.';
const SECOND_WAVE = 'The dashboard ships in the second wave.';
const RISK_HIGH = 'Timeline risk is high.';
const RISK_MITIGATED = 'Timeline risk is now mitigated.';

const buildDocument = (status: string, lines: string[]) =>
  `${frontMatter(status)}\n\n${lines.join('\n')}\n`;

const A_ORIGINAL = buildDocument('draft', BODY_LINES);

const TWO_HUNK = buildDocument(
  'draft',
  BODY_LINES.map((line) =>
    line === FIRST_WAVE ? SECOND_WAVE : line === RISK_HIGH ? RISK_MITIGATED : line,
  ),
);

// Every non-blank body line replaced. The blank lines stay blank so the
// document keeps its shape — what makes this "all changed" is that every
// change index lands inside one merge window, which collapses the whole
// document into a single hunk with `index === 0`.
const ALL_CHANGED = buildDocument(
  'draft',
  BODY_LINES.map((line, index) => (line === '' ? '' : `Rewritten line ${index}.`)),
);

// Body byte-identical to the original; only `status:` moves.
const FRONT_MATTER_ONLY = buildDocument('ready', BODY_LINES);

// One inserted line and one deleted line, far enough apart that the diff
// cannot pair them into a single `modified` entry.
//
// This fixture exists because the other four cannot exercise the view modes'
// central job. `computeLineDiff` pairs a deletion immediately followed by an
// insertion into ONE `modified` line, and every change in the fixtures above
// is a one-for-one line swap — so all four produce `modified` lines and
// nothing else. `DiffLine`'s visibility gate hides `removed` in `final` and
// `added` in `original`, and `modified` in neither. Testing the modes against
// a document with no `added` or `removed` line would leave that gate
// completely unvisited while looking like mode coverage.
const ADDED_AND_REMOVED = buildDocument(
  'draft',
  BODY_LINES.flatMap((line) =>
    line === 'Exports follow one week later.'
      ? [line, 'Exports gained a CSV target.']
      : line === 'The migration script is untested.'
        ? []
        : [line],
  ),
);

type FixtureName =
  'identical' | 'two-hunk' | 'all-changed' | 'front-matter-only' | 'added-and-removed';

const A_FIXTURES: Record<FixtureName, string> = {
  identical: A_ORIGINAL,
  'two-hunk': TWO_HUNK,
  'all-changed': ALL_CHANGED,
  'front-matter-only': FRONT_MATTER_ONLY,
  'added-and-removed': ADDED_AND_REMOVED,
};

const FIXTURE_NAMES: FixtureName[] = [
  'identical',
  'two-hunk',
  'all-changed',
  'front-matter-only',
  'added-and-removed',
];

// Three, not two. `ROADMAP.md`'s DV-1 criterion says "both view modes"; the
// component's own `VIEW_MODES` array — the one `Ctrl+Shift+D` cycles through —
// has three entries, and `final` and `original` hide different line types, so
// exercising two of them would leave a third rendering path unvisited.
const MODES: DiffViewerMode[] = ['unified', 'final', 'original'];

// `currentA` is plain state rather than `$derived(A_FIXTURES[fixture])` because
// the revert callbacks below move it to documents that are not any named
// fixture. `fixture` survives only to drive `aria-pressed` on the switcher.
const B_ORIGINAL =
  ['Sprint notes', '', 'Alpha ships Monday.', 'Beta ships Tuesday.', 'Gamma ships Wednesday.'].join(
    '\n',
  ) + '\n';
const B_CURRENT =
  [
    'Sprint notes',
    '',
    'Alpha ships Tuesday.',
    'Beta ships Wednesday.',
    'Gamma ships Thursday.',
  ].join('\n') + '\n';

// ---------------------------------------------------------------------------
// Instance C's document — DV-2, ordinary size
// ---------------------------------------------------------------------------

const C_ORIGINAL =
  ['Toolbar override probe', '', 'One unchanged line.', 'Original detail line.'].join('\n') + '\n';
const C_CURRENT =
  ['Toolbar override probe', '', 'One unchanged line.', 'Replacement detail line.'].join('\n') +
  '\n';

// ---------------------------------------------------------------------------
// Instances D and E — DV-2 at the manual tier
// ---------------------------------------------------------------------------

// The controller's tiers are measured on `max(original.length, current.length)`
// AFTER the body is normalised: under 20,000 it diffs synchronously, at 20,000
// it debounces, and at 100,000 it refuses to compute at all until something
// calls `triggerCompute()`.
//
// Twelve very long lines rather than a thousand short ones, on purpose. Both
// reach the threshold; only this one keeps the rendered diff to twelve rows
// once E's Compute Diff button finally fires, so the page does not pay for a
// four-figure DOM to make a point about a button. Measured at 102,362
// characters per side by running the real `computeLineDiff` over it.
function manualDocument(marker: string): string {
  const filler = 'lorem ipsum dolor sit amet '.repeat(315);
  return (
    Array.from(
      { length: 12 },
      (_, index) =>
        `Section ${index}: ${(index === 3 ? marker : 'baseline').padEnd(12, '.')} ${filler}`,
    ).join('\n') + '\n'
  );
}

const MANUAL_ORIGINAL = manualDocument('baseline');
const MANUAL_CURRENT = manualDocument('rewritten');

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

// Only the fields a test asserts, and `lines`/`originalLines`/`currentLines`
// as counts rather than contents — a hunk carries up to three context lines on
// each side, so its `lines` length is the cheapest way to state "this hunk
// spans the region we think it spans" without pasting the document into the
// expectation.
const summarize = (hunks: DiffHunk[]) =>
  JSON.stringify(
    hunks.map((hunk) => ({
      index: hunk.index,
      originalStart: hunk.originalStart,
      originalCount: hunk.originalCount,
      currentStart: hunk.currentStart,
      currentCount: hunk.currentCount,
      lines: hunk.lines.length,
      originalLines: hunk.originalLines.length,
      currentLines: hunk.currentLines.length,
    })),
  );

export {
  A_FIXTURES,
  A_ORIGINAL,
  B_CURRENT,
  B_ORIGINAL,
  C_CURRENT,
  C_ORIGINAL,
  FIXTURE_NAMES,
  MANUAL_CURRENT,
  MANUAL_ORIGINAL,
  MODES,
  summarize,
};
export type { FixtureName };
