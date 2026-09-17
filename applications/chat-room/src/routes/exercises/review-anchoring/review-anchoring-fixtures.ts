import { findAllOccurrences, reanchorQuote, type Thread } from '@repo/editor';

// =====================================================================
// Fixtures
// =====================================================================

// Five text blocks: h1, paragraph, h2, and two list items. The block count
// is load-bearing history rather than decoration. Before cinder PR #1266 a
// thread present in the INITIAL `threads` prop decorated the WHOLE document,
// because mapping an anchor through Milkdown's wholesale content-set step
// collapses `from` to 0 and expands `to` to docSize; ProseMirror then splits
// that one decoration into one span per text block, so the signature of the
// bug was "span count === text-block count" — five spans here. The fixed
// build recognises a whole-document replacement, refuses to map through it,
// and locates anchors by quote instead. This document is now the control
// case for "one span per anchor, no matter when the thread arrives".
const releasePlan = `# Release Plan

The first release includes a dashboard and export actions.

## Checklist

- Finalize the component API
- Add playground coverage`;

// Two blocks, so the ProseMirror positions the buttons below hard-code stay
// checkable by hand:
//
//   PM  0        heading opens
//   PM  1..13    "Release Plan"
//   PM 14        paragraph opens
//   PM 15..73    "The first release includes a dashboard and export actions."
//   PM 44..53    "dashboard"  (15 + the 29 characters that precede it)
const shortPlan = `# Release Plan

The first release includes a dashboard and export actions.`;

// Two paragraphs, one repeated word — the ambiguity fixture.
//
//   PM  1..19    "Alpha widget beta."   ("widget" at  7..13)
//   PM 21..40    "Gamma widget delta."  ("widget" at 27..33)
//
// As text: "Alpha widget beta.\nGamma widget delta.", first "widget" at
// offset 6, second at 25.
const widgets = `Alpha widget beta.

Gamma widget delta.`;

function comment(threadId: string, body: string) {
  return [
    {
      id: `${threadId}-comment`,
      threadId,
      authorId: 'maya',
      body,
      createdAt: '2026-08-11T12:00:00.000Z',
    },
  ];
}

// =====================================================================
// Instance 1 — anchors seeded at mount
// =====================================================================

const mountThreads: Thread[] = [
  {
    id: 'mount-title',
    createdAt: '2026-08-11T12:00:00.000Z',
    anchor: {
      from: 1,
      to: 13,
      quote: 'Release Plan',
      prefix: '# ',
      suffix: '\n\nThe first release',
      status: 'anchored',
      originalQuote: 'Release Plan',
      lastKnownOffset: 0,
    },
    comments: comment('mount-title', 'Title reads well.'),
  },
  {
    id: 'mount-dashboard',
    createdAt: '2026-08-11T12:01:00.000Z',
    anchor: {
      from: 44,
      to: 53,
      quote: 'dashboard',
      prefix: 'The first release includes a ',
      suffix: ' and export actions.',
      status: 'anchored',
      originalQuote: 'dashboard',
      lastKnownOffset: 42,
    },
    comments: comment('mount-dashboard', 'Which dashboard?'),
  },
  {
    id: 'mount-document',
    createdAt: '2026-08-11T12:02:00.000Z',
    anchor: {
      from: 0,
      to: 0,
      quote: '',
      prefix: '',
      suffix: '',
      type: 'document',
      status: 'anchored',
    },
    comments: comment('mount-document', 'Overall: ship it.'),
  },
];

const offByOneThreads: Thread[] = [
  {
    id: 'offbyone-title',
    createdAt: '2026-08-11T12:00:00.000Z',
    anchor: {
      from: 2,
      to: 14,
      quote: 'Release Plan',
      prefix: '# ',
      suffix: '\n\nThe first release',
      status: 'anchored',
      originalQuote: 'Release Plan',
      lastKnownOffset: 0,
    },
    comments: comment('offbyone-title', 'Anchored one position right, in a heading.'),
  },
  {
    id: 'offbyone-dashboard',
    createdAt: '2026-08-11T12:01:00.000Z',
    anchor: {
      from: 45,
      to: 54,
      quote: 'dashboard',
      prefix: 'The first release includes a ',
      suffix: ' and export actions.',
      status: 'anchored',
      originalQuote: 'dashboard',
      lastKnownOffset: 42,
    },
    comments: comment('offbyone-dashboard', 'Anchored one position right, in a paragraph.'),
  },
];

const driftThreads: Thread[] = [
  {
    id: 'drift-dashboard',
    createdAt: '2026-08-11T12:00:00.000Z',
    anchor: {
      from: 44,
      to: 53,
      quote: 'dashboard',
      prefix: 'The first release includes a ',
      suffix: ' and export actions.',
      status: 'anchored',
      originalQuote: 'dashboard',
      lastKnownOffset: 42,
    },
    comments: comment('drift-dashboard', 'Name the dashboard.'),
  },
];

const ambiguousThreads: Thread[] = [
  {
    id: 'ambiguous-widget',
    createdAt: '2026-08-11T12:00:00.000Z',
    anchor: {
      from: 27,
      to: 33,
      quote: 'widget',
      prefix: 'Alpha widget beta.\nGamma ',
      suffix: ' delta.',
      status: 'anchored',
      originalQuote: 'widget',
      lastKnownOffset: 25,
    },
    comments: comment('ambiguous-widget', 'This one, not the first one.'),
  },
];

const lateThreads: Thread[] = [
  {
    id: 'late-title',
    createdAt: '2026-08-11T12:00:00.000Z',
    anchor: {
      from: 1,
      to: 13,
      quote: 'Release Plan',
      prefix: '# ',
      suffix: '\n\nThe first release',
      status: 'anchored',
      originalQuote: 'Release Plan',
      lastKnownOffset: 0,
    },
    comments: comment('late-title', 'Assigned after the editor mounted.'),
  },
];

const pureDocument = 'Release Plan\nThe first release includes a dashboard and export actions.';
const perfectMatch = reanchorQuote(pureDocument, {
  quote: 'dashboard',
  prefix: 'includes a ',
  suffix: ' and export',
});
const garbageContextMatch = reanchorQuote(pureDocument, {
  quote: 'dashboard',
  prefix: 'ZZZZZZZZZZZ',
  suffix: 'QQQQQQQQQQQ',
});
const absentMatch = reanchorQuote(pureDocument, {
  quote: 'sparkline',
  prefix: 'includes a ',
  suffix: ' and export',
});
const emptyQuoteMatch = reanchorQuote(pureDocument, { quote: '', prefix: '', suffix: '' });
const movedWidgetDocument = 'Alpha widget beta.\nGamma  delta. widget';
const ambiguousMatch = reanchorQuote(movedWidgetDocument, {
  quote: 'widget',
  prefix: 'Alpha widget beta.\nGamma ',
  suffix: ' delta.',
  lastKnownOffset: 25,
});
const overlappingOccurrences = findAllOccurrences('aa', 'aaaa');
const emptyQuoteOccurrences = findAllOccurrences('', 'aaaa');
const showResult = (result: { found: boolean; from: number; confidence: number }) =>
  `found=${result.found} from=${result.from} confidence=${result.confidence.toFixed(3)}`;

export {
  absentMatch,
  ambiguousMatch,
  ambiguousThreads,
  comment,
  driftThreads,
  emptyQuoteMatch,
  emptyQuoteOccurrences,
  garbageContextMatch,
  lateThreads,
  mountThreads,
  offByOneThreads,
  overlappingOccurrences,
  perfectMatch,
  releasePlan,
  shortPlan,
  showResult,
  widgets,
};
