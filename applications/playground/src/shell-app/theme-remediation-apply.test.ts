/**
 * Applying and undoing a remediation (COR-487): one atomic transaction, locks and other
 * color modes untouched, stale proposals rejected, Undo byte-identical to the prior source
 * and locks, the restore fallbacks, and the detach-and-repair path for linked aliases.
 */

import { describe, expect, test } from 'bun:test';

import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { evaluator as stubEvaluator } from './theme-builder-test-support.ts';
import { countReport, exportReadiness } from './theme-check-engine.ts';
import type { ReportRecord } from './theme-check-types.ts';
import { createDraft } from './theme-draft.ts';
import { commitTransaction, createHistory } from './theme-history.ts';
import {
  applyProposal,
  proposeForFinding,
  recomputeProposal,
  staleReason,
} from './theme-remediation-apply.ts';
import { changedOtherModeContexts, reportForEnvelope } from './theme-remediation-check.ts';
import type { RemediationProposal, RemediationRequest } from './theme-remediation-proposal.ts';
import { proposeRestoreLastValid } from './theme-remediation-restore.ts';
import {
  dimmedText,
  findFinding,
  memoEvaluator,
  oklchColor,
  openController,
  shippedEnvelope,
  textOnCanvas,
  withOverride,
} from './theme-remediation-support.ts';

// Runtime work happens once, at module scope; the evaluator remembers it by content.
const grayCanvas = withOverride('light', 'surface.canvas', oklchColor(0.5, 0, 0));
const aliased = withOverride('light', 'text.default', {
  $type: 'color',
  $value: '{surface.raised}',
});
const dimmedRecord = await findFinding(dimmedText, textOnCanvas);
const grayRecord = await findFinding(grayCanvas, textOnCanvas);
const aliasRecord = await findFinding(aliased, textOnCanvas);

const requestFor = (
  controller: ThemeBuilderController,
  record: ReportRecord,
): RemediationRequest => ({
  draft: controller.draft!,
  record,
  evaluator: memoEvaluator,
  gamut: 'srgb',
});

async function proposalFor(
  controller: ThemeBuilderController,
  record: ReportRecord,
): Promise<RemediationProposal> {
  const result = await proposeForFinding(requestFor(controller, record));
  if (!result.ok) throw new Error(result.message);
  return result.proposal;
}

const recompute =
  (controller: ThemeBuilderController, record: ReportRecord, p: RemediationProposal) => () =>
    recomputeProposal(requestFor(controller, record), p.action);

const snapshot = (controller: ThemeBuilderController): string =>
  JSON.stringify(controller.draft!.envelope);

describe('apply and undo', () => {
  test('Apply is one atomic remediation transaction, and Undo restores the exact source', async () => {
    const { controller } = await openController(dimmedText);
    const before = snapshot(controller);
    const entries = controller.history!.entries.length;
    const proposal = await proposalFor(controller, dimmedRecord);
    const outcome = await applyProposal(
      controller,
      proposal,
      recompute(controller, dimmedRecord, proposal),
    );
    expect(outcome.ok).toBe(true);
    expect(controller.history!.entries).toHaveLength(entries + 1);
    expect(controller.history!.entries.at(-1)).toMatchObject({
      kind: 'remediation',
      label: proposal.title,
    });
    expect(controller.draft!.envelope.overrides.light).toEqual(proposal.state.overrides.light);
    expect(controller.announcement).toContain('Replace value with OKLCH applied');
    expect(snapshot(controller)).not.toBe(before);

    // All affected findings are recomputed: the report for the new source is clean.
    const { report } = await reportForEnvelope(memoEvaluator, controller.draft!.envelope, 9);
    expect(countReport(report)['accessibility-error']).toBe(0);
    expect(exportReadiness(report, true, false)).toBe('ready');

    await controller.undo();
    expect(snapshot(controller)).toBe(before);
  });

  test('locked tokens and the other color mode never change; locks survive Apply and Undo', async () => {
    const { controller } = await openController(dimmedText);
    await controller.setLocked('accent.text', true);
    const lockedBefore = JSON.stringify(controller.draft!.envelope.locked);
    const before = snapshot(controller);
    const proposal = await proposalFor(controller, dimmedRecord);
    const darkBefore = await reportForEnvelope(memoEvaluator, controller.draft!.envelope, 1);
    const applied = await applyProposal(
      controller,
      proposal,
      recompute(controller, dimmedRecord, proposal),
    );
    expect(applied.ok).toBe(true);
    expect(JSON.stringify(controller.draft!.envelope.locked)).toBe(lockedBefore);
    expect(controller.lockedPaths.has('accent.text')).toBe(true);
    expect(controller.draft!.envelope.overrides.dark).toEqual(dimmedText.overrides.dark);
    const darkAfter = await reportForEnvelope(memoEvaluator, controller.draft!.envelope, 2);
    expect(
      changedOtherModeContexts('light', darkBefore.evaluations, darkAfter.evaluations),
    ).toEqual([]);
    await controller.undo();
    expect(snapshot(controller)).toBe(before);
  });

  test('a locked foreground is never offered a fix', async () => {
    const { controller } = await openController(dimmedText);
    await controller.setLocked('text.default', true);
    const result = await proposeForFinding(requestFor(controller, dimmedRecord));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('text.default is locked');
    expect(result.manual).toContain('Unlock text.default');
  });

  test('a proposal is stale after the source or the locks change, and nothing is applied', async () => {
    const { controller } = await openController(dimmedText);
    const proposal = await proposalFor(controller, dimmedRecord);
    expect(staleReason(proposal, controller.draft)).toBeNull();
    await controller.setLocked('accent.text', true);
    const before = snapshot(controller);
    const rejected = await applyProposal(
      controller,
      proposal,
      recompute(controller, dimmedRecord, proposal),
    );
    expect(rejected).toMatchObject({ ok: false, stale: true });
    expect(rejected.message).toContain('Propose the fix again');
    expect(snapshot(controller)).toBe(before);
  });

  test('a proposal whose target was locked meanwhile is rejected', async () => {
    const { controller } = await openController(dimmedText);
    const proposal = await proposalFor(controller, dimmedRecord);
    await controller.setLocked('text.default', true);
    const rejected = await applyProposal(
      controller,
      proposal,
      recompute(controller, dimmedRecord, proposal),
    );
    expect(rejected.ok).toBe(false);
    // The lock is a committed transaction, so the revision moved too; a lock set that moved
    // without a revision change is caught on its own.
    expect(staleReason(proposal, controller.draft)).toContain('source changed');
    const sameRevision = {
      ...createDraft(dimmedText),
      envelope: { ...dimmedText, locked: ['text.default'] },
    };
    expect(
      staleReason({ ...proposal, binding: { ...proposal.binding, revision: 1 } }, sameRevision),
    ).toContain('locked tokens changed');
  });

  test('a proposal that no longer recomputes to the same state is rejected', async () => {
    const { controller } = await openController(dimmedText);
    const proposal = await proposalFor(controller, dimmedRecord);
    const forged = { ...proposal, state: { ...proposal.state, cssOverrides: { x: {} } } };
    const before = snapshot(controller);
    const rejected = await applyProposal(
      controller,
      forged,
      recompute(controller, dimmedRecord, proposal),
    );
    expect(rejected).toMatchObject({ ok: false, stale: true });
    expect(snapshot(controller)).toBe(before);
  });
});

describe('detach and repair', () => {
  test('a linked alias is detached and repaired as one visible transaction, and Undo restores the link', async () => {
    const { controller } = await openController(aliased);
    const before = snapshot(controller);
    const proposal = await proposalFor(controller, aliasRecord);
    expect(proposal.action).toBe('detach-and-repair');
    expect(proposal.label).toBe('Detach and repair');
    expect(proposal.notes[0]).toContain('linked alias');
    const target = proposal.changes.find((row) => row.role === 'target');
    expect(target?.before).toBe('{surface.raised}');
    expect(target?.after).toContain('oklch(');
    const entries = controller.history!.entries.length;
    const applied = await applyProposal(
      controller,
      proposal,
      recompute(controller, aliasRecord, proposal),
    );
    expect(applied.ok).toBe(true);
    expect(controller.history!.entries).toHaveLength(entries + 1);
    const node = (
      controller.draft!.envelope.overrides.light as { text: { default: { $value: unknown } } }
    ).text.default;
    expect(node.$value).toMatchObject({ colorSpace: 'oklch' });
    await controller.undo();
    expect(snapshot(controller)).toBe(before);
  });
});

describe('restore fallbacks', () => {
  test('no candidate: the blocking constraints are explained and a passing restore is offered', async () => {
    const { controller } = await openController(grayCanvas);
    const result = await proposeForFinding(requestFor(controller, grayRecord));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no single color on the search grid passes all of them');
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.restore?.action).toBe('restore-overrides');
    expect(result.restore?.label).toBe('Restore affected overrides');
    expect(result.restore?.state.overrides.light).toEqual({});

    const before = snapshot(controller);
    const restore = result.restore!;
    const applied = await applyProposal(
      controller,
      restore,
      recompute(controller, grayRecord, restore),
    );
    expect(applied.ok).toBe(true);
    expect(controller.draft!.envelope.overrides.light).toEqual({});
    await controller.undo();
    expect(snapshot(controller)).toBe(before);
  });

  test('a restore that cannot pass the regression check is not offered; the manual step is', async () => {
    const { controller } = await openController(grayCanvas);
    await controller.setLocked('surface.canvas', true);
    const result = await proposeForFinding(requestFor(controller, grayRecord));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.restore).toBeNull();
    expect(result.manual).toContain('surface.canvas');
  });

  test('a finding with no pairing offers a manual instruction and no button when nothing is safe', async () => {
    const { controller } = await openController(shippedEnvelope);
    const record = {
      ...dimmedRecord,
      id: 'cinder-profile-range:--cinder-opacity-disabled:light/default',
      ruleId: 'cinder-profile-range',
      pairingId: null,
      stack: [],
      tokenPaths: ['opacity.disabled'],
    } satisfies ReportRecord;
    const result = await proposeForFinding(requestFor(controller, record));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.restore).toBeNull();
    expect(result.manual).toContain('opacity.disabled');
  });

  test('a rendered or non-contrast finding gets a restore only through the same check', async () => {
    const { controller } = await openController(dimmedText);
    const record = {
      ...dimmedRecord,
      id: 'cinder-profile-range:--cinder-text-default:light/default',
      ruleId: 'cinder-profile-range',
      pairingId: null,
      stack: [],
    } satisfies ReportRecord;
    const result = await proposeForFinding(requestFor(controller, record));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.action).toBe('restore-overrides');
  });

  test('Restore last valid value returns an invalid token to its earlier value and guesses nothing', async () => {
    const invalid = withOverride('shared', 'radius.medium', {
      $type: 'dimension',
      $value: { value: 4, unit: 'furlong' },
    });
    const draft = createDraft(invalid);
    const valid = createHistory({ overrides: shippedEnvelope.overrides, cssOverrides: {} });
    const history = commitTransaction(valid, 'edit', 'Set the radius', {
      overrides: invalid.overrides,
      cssOverrides: {},
    });
    const diagnostic = {
      context: 'light/default' as const,
      path: 'radius.medium',
      message: 'unit',
    };
    const proposal = await proposeRestoreLastValid(draft, history, stubEvaluator, diagnostic);
    expect(proposal?.label).toBe('Restore last valid value');
    expect(proposal?.state.overrides).toEqual(shippedEnvelope.overrides);
    // It restores a value that existed; it never writes an alias reference.
    expect(JSON.stringify(proposal?.state)).not.toContain('"{');
    const none = await proposeRestoreLastValid(draft, valid, stubEvaluator, diagnostic);
    expect(none).toBeNull();
  });
});
