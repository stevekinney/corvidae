import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { isStreamingMessage } from '@lostgradient/chat';
import casesData from '../src/fixtures/chat-stress.json';
import {
  OWNER_AUDIT_SCENARIO_MAPPING,
  STRESS_CASE_COUNT,
  STRESS_NOW,
  STRESS_SCENARIO_NAMES,
  findStressCase,
  parseStressCases,
  stressCaseProblems,
  type StressCase,
  type StressStep,
} from '../src/fixtures/chat-stress/stress-cases.ts';
import { buildStressSetup } from '../src/fixtures/chat-stress/stress-scenarios.ts';

const cases = parseStressCases(casesData);
const LONG_TOOL = 'orders_reconciliation_ledger_export_with_a_very_long_generated_identifier_v2';

function sample(overrides: Partial<StressCase> = {}): StressCase {
  return {
    id: 1,
    slug: 'sample',
    title: 'A sample.',
    provenance: 'derived',
    source: 'A test.',
    rows: ['C1'],
    scenario: 'idle',
    params: {},
    steps: [],
    variants: [],
    focusSweep: false,
    ...overrides,
  };
}

describe('the committed Chat stress cases', () => {
  it('seeds empty content only for the empty-answer turn cases', () => {
    for (const id of [22, 77]) {
      const stressCase = findStressCase(cases, id);
      expect(stressCase).toBeDefined();
      if (stressCase === undefined) continue;

      const assistant = Object.values(buildStressSetup(stressCase).conversation.messages).find(
        (message) => message.role === 'assistant',
      );
      expect(assistant?.content).toBe('');
    }

    const partial = findStressCase(cases, 17);
    expect(partial).toBeDefined();
    if (partial === undefined) return;
    const assistant = Object.values(buildStressSetup(partial).conversation.messages).find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.content).toBe('The October ledger has 212 entries and three of them');
  });

  it('seeds case 23 pending at load and expired only after its live deadline', () => {
    const expiredCase = findStressCase(cases, 23);
    expect(expiredCase).toBeDefined();
    if (expiredCase === undefined) return;

    const approval = Object.values(buildStressSetup(expiredCase).conversation.messages)
      .map((message) => message.toolResult)
      .find((result) => result?.action?.type === 'approval');
    expect(approval?.outcome).toBe('action_required');
    expect(approval?.action?.type).toBe('approval');
    if (approval?.action?.type !== 'approval') return;

    const now = Date.parse(STRESS_NOW);
    const expiresAt = Date.parse(approval.action.expiresAt ?? '');
    expect(approval.action.message).toBe('Refund order 4471 for $42.00?');
    expect(expiresAt).toBe(now + 30_000);
    expect(expiresAt).toBeGreaterThan(now);
    expect(expiresAt).toBeLessThanOrEqual(now + 31_000);
  });

  it('keeps approval metadata keyed to every approval witness', () => {
    const identifier = findStressCase(cases, 24);
    expect(identifier).toBeDefined();
    if (identifier !== undefined) {
      expect(buildStressSetup(identifier).approvalDetails[LONG_TOOL]).toEqual({
        irreversible: true,
        approveLabel: 'Run export',
      });
    }

    const two = findStressCase(cases, 53);
    expect(two).toBeDefined();
    if (two !== undefined) {
      const details = buildStressSetup(two).approvalDetails;
      expect(details['issue_refund']?.approveLabel).toBe('Refund $42.00');
      expect(details['refund-4472']).toMatchObject({
        irreversible: true,
        approveLabel: 'Refund $18.00',
        facts: [
          { label: 'Target', value: 'order 4472' },
          { label: 'Amount', value: '$18.00' },
        ],
      });
    }
  });

  it('preserves the offscreen approval history and citation source inventory', () => {
    const offscreen = findStressCase(cases, 57);
    expect(offscreen).toBeDefined();
    if (offscreen !== undefined) {
      const setup = buildStressSetup(offscreen);
      expect(setup.conversation.ids.length).toBeGreaterThan(17);
      expect(
        Object.values(setup.conversation.messages).filter((message) => message.role === 'user'),
      ).toHaveLength(9);
    }

    const citations = findStressCase(cases, 45);
    expect(citations).toBeDefined();
    if (citations !== undefined) {
      expect(buildStressSetup(citations).sources[0]).toHaveLength(6);
    }
  });

  it('backs every named approval action witness with setup metadata', () => {
    for (const stressCase of cases) {
      const setup = buildStressSetup(stressCase);
      const namedApprovalActions = new Set(
        Object.values(setup.approvalDetails)
          .map((details) => details.approveLabel)
          .filter((label): label is string => label !== undefined),
      );
      const expectedButtons = stressCase.steps
        .concat(...stressCase.variants.map((variant) => variant.steps))
        .filter(
          (step): step is Extract<StressStep, { action: 'expect' }> =>
            step.action === 'expect' && step.role === 'button',
        )
        .map((step) => step.name)
        .filter(
          (name) => name === 'Approve' || name.startsWith('Refund ') || name === 'Run export',
        );
      for (const name of expectedButtons) {
        expect(name === 'Approve' || namedApprovalActions.has(name)).toBe(true);
      }
    }
  });

  it('keeps attachment shelf witnesses aligned with responsive caps and reveal', () => {
    const readyShelf = findStressCase(cases, 50);
    const boundedShelf = findStressCase(cases, 61);
    const primaryUpload = readyShelf?.steps.find((step) => step.action === 'upload');
    const reveal = readyShelf?.variants.find((variant) => variant.name === 'revealed');
    const boundedUpload = boundedShelf?.steps.find((step) => step.action === 'upload');
    const boundedCount = boundedShelf?.steps.find((step) => step.action === 'expect-text');
    const primaryCount = readyShelf?.steps.find((step) => step.action === 'expect-text');
    const revealCount = reveal?.steps.find((step) => step.action === 'expect-text');
    const primaryShelf = readyShelf?.steps.find(
      (step) => step.action === 'expect-attachment-shelf',
    );
    const revealedShelf = reveal?.steps.find((step) => step.action === 'expect-attachment-shelf');
    expect(primaryUpload?.files).toBeDefined();
    expect(reveal?.steps.find((step) => step.action === 'upload')?.files).toEqual(
      primaryUpload?.files,
    );
    const uploadedFiles = primaryUpload?.files ?? [];
    expect(primaryCount?.text).toBe(`${uploadedFiles.length} files`);
    expect(revealCount?.text).toBe(`${uploadedFiles.length} files`);
    expect(primaryShelf).toEqual({ action: 'expect-attachment-shelf', total: 4 });
    expect(revealedShelf).toMatchObject({
      action: 'expect-attachment-shelf',
      total: 4,
      reveal: true,
    });

    const boundedFiles = boundedUpload?.files ?? [];
    expect(boundedCount?.text).toBe(`${boundedFiles.length} files`);
    expect(boundedShelf?.steps).toContainEqual({
      action: 'expect-attachment-shelf',
      total: 14,
    });

    const unsupported = findStressCase(cases, 62);
    const unsupportedPrimaryShelf = unsupported?.steps.find(
      (step) => step.action === 'expect-attachment-shelf',
    );
    const unsupportedReveal = unsupported?.variants.find((variant) => variant.name === 'revealed');
    const unsupportedRevealedShelf = unsupportedReveal?.steps.find(
      (step) => step.action === 'expect-attachment-shelf',
    );
    expect(unsupportedPrimaryShelf).toEqual({ action: 'expect-attachment-shelf', total: 2 });
    expect(unsupportedPrimaryShelf).not.toHaveProperty('reveal');
    expect(unsupportedRevealedShelf).toEqual({
      action: 'expect-attachment-shelf',
      total: 2,
      reveal: true,
    });
    expect(unsupportedReveal?.steps).toContainEqual({
      action: 'expect',
      role: 'button',
      name: 'Retry upload-fail-2.pdf',
    });
  });

  it('exercises the denied approval note through the visible controls', () => {
    const denied = findStressCase(cases, 49);
    expect(denied?.steps).toEqual([
      { action: 'click', role: 'button', name: 'Add a note' },
      {
        action: 'fill',
        role: 'textbox',
        name: 'Note (optional)',
        text: 'The duplicate charge was already refunded.',
      },
      { action: 'click', role: 'button', name: 'Deny' },
      { action: 'expect-text', text: 'Denied' },
      { action: 'expect-text', text: 'The duplicate charge was already refunded.' },
    ]);
  });

  it('seeds the live reasoning witness as a real streaming message', () => {
    const reasoning = findStressCase(cases, 71);
    expect(reasoning).toBeDefined();
    if (reasoning === undefined) return;
    const assistant = Object.values(buildStressSetup(reasoning).conversation.messages).find(
      (message) => message.role === 'assistant',
    );
    expect(assistant).toBeDefined();
    if (assistant === undefined) return;
    expect(isStreamingMessage(assistant)).toBe(true);
    expect(assistant.content).toBe('Yes, the order was charged twice.');
  });

  it('holds exactly the 80 cases the board requires, numbered 1 to 80', () => {
    expect(cases).toHaveLength(STRESS_CASE_COUNT);
    expect(cases.map((stressCase) => stressCase.id)).toEqual(
      Array.from({ length: STRESS_CASE_COUNT }, (_, index) => index + 1),
    );
  });

  it('names a scenario the fixture can build for every case', () => {
    for (const stressCase of cases) {
      expect(STRESS_SCENARIO_NAMES).toContain(stressCase.scenario);
    }
  });

  it('gives every case a source and at least one design row', () => {
    for (const stressCase of cases) {
      expect(stressCase.source.length).toBeGreaterThan(0);
      expect(stressCase.rows.length).toBeGreaterThan(0);
    }
  });

  it('marks the cases the board issues name, with the sentence that names them', () => {
    const named = [
      9, 10, 11, 14, 15, 17, 19, 21, 23, 24, 25, 27, 31, 32, 33, 34, 41, 44, 45, 50, 51, 52, 59, 63,
      68, 69, 71, 72, 73, 79,
    ];
    for (const id of named) {
      expect(findStressCase(cases, id)?.provenance).toBe('issue-named');
    }
  });

  it('carries the fixed variants the board requires, and only those', () => {
    const variants = cases.flatMap((stressCase) =>
      stressCase.variants.map((variant) => `${stressCase.id}-${variant.name}`),
    );
    expect(variants.toSorted()).toEqual(
      [
        '33-expanded',
        '9-stop-tooltip',
        '25-phone-docked',
        '30-two-queued-one-editing',
        '39-actions-focused',
        '39-rtl-sources-open',
        '39-sources-review-reachable',
        '37-source-list-contract',
        '48-expanded',
        '51-long-middle-filename',
        '54-expanded',
        '56-grantor-tooltip',
        '10-waiting-to-streaming',
        '18-stopped-to-failed',
        '50-revealed',
        '51-revealed',
        '61-revealed',
        '62-revealed',
        '57-reviewed',
        '59-collapsed',
        '68-option2',
        '68-something-else',
        '69-question-2-of-3',
        '71-live',
        '71-folded',
        '72-scrolled',
        '60-safe-area-override',
        '63-empty-and-ready',
        '79-discard-drawer',
        '79-restored-after-discard',
      ].toSorted(),
    );
  });

  it('maps every owner-audit scenario to an actual case and capture variant', () => {
    for (const [auditId, caseId, variant] of OWNER_AUDIT_SCENARIO_MAPPING) {
      const stressCase = cases.find((candidate) => candidate.id === caseId);
      expect(stressCase, `owner audit ${auditId} case ${caseId}`).toBeDefined();
      if (stressCase === undefined || variant === undefined) continue;
      if (variant === 'focus-1') {
        expect(stressCase.focusSweep, `owner audit ${auditId} focus sweep`).toBe(true);
      } else {
        expect(
          stressCase.variants.some((candidate) => candidate.name === variant),
          `owner audit ${auditId} variant ${variant}`,
        ).toBe(true);
      }
    }
  });

  it('makes the audited variants prove their requested observable state', () => {
    const queued = findStressCase(cases, 30)?.variants.find(
      (variant) => variant.name === 'two-queued-one-editing',
    );
    expect(queued?.steps).toEqual([
      expect.objectContaining({ action: 'fill', text: 'First follow-up' }),
      expect.objectContaining({ action: 'press', key: 'Enter' }),
      expect.objectContaining({ action: 'fill', text: 'Second follow-up' }),
      expect.objectContaining({ action: 'press', key: 'Enter' }),
      expect.objectContaining({ action: 'click', name: 'Edit queued follow-up 1' }),
      expect.objectContaining({ action: 'expect', role: 'textbox', name: 'Message' }),
    ]);

    const upload = findStressCase(cases, 51)?.variants.find(
      (variant) => variant.name === 'long-middle-filename',
    );
    expect(upload?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'expect-attachment-shelf',
          total: 2,
          reveal: true,
        }),
        expect.objectContaining({ action: 'expect-text', text: '42%' }),
        expect.objectContaining({ action: 'expect-text', text: 'quarterly' }),
      ]),
    );

    const rtl = findStressCase(cases, 39)?.variants.find(
      (variant) => variant.name === 'rtl-sources-open',
    );
    expect(rtl?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'expect-text', text: 'سياسة الاسترداد' }),
        expect.objectContaining({ action: 'expect-text', text: 'توضح السياسة' }),
      ]),
    );

    const safeArea = findStressCase(cases, 60)?.variants.find(
      (variant) => variant.name === 'safe-area-override',
    );
    expect(safeArea?.steps[0]).toEqual({
      action: 'hook',
      name: 'setSafeAreaInset',
      argument: 24,
    });
  });

  it('requires semantic composer transition variants to capture a same-page endpoint change', () => {
    const waitingToStreaming = findStressCase(cases, 10)?.variants.find(
      (variant) => variant.name === 'waiting-to-streaming',
    );
    expect(waitingToStreaming?.steps).toEqual(
      expect.arrayContaining([
        { action: 'expect-empty-streaming-assistant' },
        { action: 'measure-composer-top', name: 'before' },
        { action: 'expect-streaming-assistant-text', text: 'The ledger is ready.' },
        { action: 'measure-composer-top', name: 'after' },
      ]),
    );
    expect(findStressCase(cases, 10)?.variants).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'waiting-to-streaming' })]),
    );
    expect(findStressCase(cases, 18)?.variants).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'stopped-to-failed' })]),
    );
  });

  it('asks for a focus sweep on case 73 alone', () => {
    expect(
      cases.filter((stressCase) => stressCase.focusSweep).map((stressCase) => stressCase.id),
    ).toEqual([73]);
  });

  it('pairs the composer edge of cases 9 and 10, and of 14 and 15, in both directions', () => {
    expect(findStressCase(cases, 9)?.composerEdgeWith).toBe(10);
    expect(findStressCase(cases, 10)?.composerEdgeWith).toBe(9);
    expect(findStressCase(cases, 14)?.composerEdgeWith).toBe(15);
    expect(findStressCase(cases, 15)?.composerEdgeWith).toBe(14);
  });

  it('reaches the queue, the question and the offline states through steps, never through seeded end states', () => {
    const offline = findStressCase(cases, 79);
    expect(buildStressSetup(offline!).turnStates[0]).toEqual({ kind: 'streaming' });
    expect(offline?.steps.map((step) => step.action)).toEqual([
      'fill',
      'press',
      'fill',
      'press',
      'hook',
      'expect-text',
      'expect-text',
    ]);
    const progression = findStressCase(cases, 69);
    expect(progression?.variants[0]?.steps.map((step) => step.action)).toEqual([
      'click',
      'click',
      'expect-text',
    ]);
  });

  it('witnesses the host-supplied A5 approval receipt in case 55', () => {
    const receipt = cases.find((stressCase) => stressCase.id === 55);
    expect(receipt?.rows).toContain('A5');
    expect(receipt?.deferred).toBeUndefined();
    expect(receipt?.steps).toContainEqual({ action: 'expect', role: 'link', name: 'Reviews' });
  });

  it('keeps the middle dot out of every title and source', () => {
    const middleDot = String.fromCodePoint(0xb7);
    for (const stressCase of cases) {
      expect(`${stressCase.title} ${stressCase.source}`).not.toContain(middleDot);
    }
  });
});

describe('stressCaseProblems', () => {
  it('accepts the committed data', () => {
    expect(stressCaseProblems(casesData)).toEqual([]);
  });

  it('rejects data that is not an array', () => {
    expect(stressCaseProblems({})).toEqual(['the cases must be an array']);
  });

  it('names a missing and a repeated number', () => {
    const repeated = [...casesData.slice(0, 79), sample({ id: 1 })];
    const problems = stressCaseProblems(repeated);
    expect(problems).toContain('case 1 appears twice');
    expect(problems).toContain('case 80 is missing');
  });

  it('rejects a step that names an unknown action', () => {
    const broken = { ...sample(), steps: [{ action: 'wait', milliseconds: 500 }] };
    expect(stressCaseProblems([broken])[0]).toContain('unknown step action "wait"');
  });

  it('rejects a click that names no control', () => {
    const broken = { ...sample(), steps: [{ action: 'click', role: 'button' }] };
    expect(stressCaseProblems([broken]).join('\n')).toContain('click needs a name');
  });

  it('rejects a composer-edge partner that is not a case', () => {
    const problems = stressCaseProblems([sample({ composerEdgeWith: 99 })]);
    expect(problems.join('\n')).toContain('composer-edge partner 99');
  });

  it('rejects a case that repeats a variant name', () => {
    const repeated = sample({
      variants: [
        { name: 'expanded', steps: [] },
        { name: 'expanded', steps: [] },
      ],
    });
    expect(stressCaseProblems([repeated]).join('\n')).toContain('repeats a variant name');
  });

  it('refuses to parse invalid data, naming every problem', () => {
    expect(() => parseStressCases([sample()])).toThrow('Chat stress cases are invalid');
  });
});

describe('the design-review rows', () => {
  const rows = readFileSync(
    new URL('../src/fixtures/chat-stress.rows.txt', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('|').map((field) => field.trim()));

  it('are written as the design-review skill reads them: row id, board and text', () => {
    for (const fields of rows) {
      expect(fields).toHaveLength(3);
      expect(fields.every((field) => field !== '')).toBe(true);
    }
    const ids = rows.map((fields) => fields[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('are the 44 rows the board issues carry text for', () => {
    expect(rows).toHaveLength(44);
  });

  it('are each shown by at least one case, and every row a case names exists', () => {
    const ids = new Set(rows.map((fields) => fields[0]));
    const shown = new Set(cases.flatMap((stressCase) => stressCase.rows));
    for (const id of ids) expect(shown.has(id as string)).toBe(true);
    for (const id of shown) expect(ids.has(id)).toBe(true);
  });
});
