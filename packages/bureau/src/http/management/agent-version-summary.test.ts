/**
 * COR-2429 — what a saved version of an agent changed, in words (`summarizeVersion`): a first
 * version reads Created, tools are named as the agent page names them, a record such as the
 * approvals names each entry it set or removed, and each changed key says its own change.
 */
import { describe, expect, it } from 'bun:test';

import { summarizeVersion } from './agent-version-summary.ts';

describe('summarizeVersion', () => {
  it('reads Created for a first version, and says a save that changed nothing', () => {
    expect(
      summarizeVersion({ changedKeys: ['tools'], current: {}, previous: {}, first: true }),
    ).toBe('Created');
    expect(summarizeVersion({ changedKeys: [], current: {}, previous: {}, first: false })).toBe(
      'Saved with no change',
    );
  });

  it('names tools by their display names and the approvals each tool was given', () => {
    const summary = summarizeVersion({
      changedKeys: ['tools', 'approvals'],
      current: {
        tools: ['lookup-order', 'demo:issue-refund'],
        approvals: { 'demo:issue-refund': 'always' },
      },
      previous: { tools: ['lookup-order'], approvals: { 'lookup-order': 'never' } },
      first: false,
    });
    expect(summary).toBe(
      'Tools: added Issue refund; Approvals: Issue refund always, Lookup order removed',
    );
  });

  it('quotes the instruction lines added and removed, and a model moved from one to another', () => {
    const summary = summarizeVersion({
      changedKeys: ['instructions', 'model'],
      current: { instructions: 'Be careful.\nRefunds over $25 need approval.', model: 'b/new' },
      previous: { instructions: 'Be careful.', model: 'a/old' },
      first: false,
    });
    expect(summary).toBe(
      'Instructions: added “Refunds over $25 need approval.”; Model: a/old to b/new',
    );
  });

  it('says only that a key changed when the version before it is no longer kept', () => {
    expect(
      summarizeVersion({
        changedKeys: ['model'],
        current: { model: 'b/new' },
        previous: undefined,
        first: false,
      }),
    ).toBe('Model: changed');
  });
});
