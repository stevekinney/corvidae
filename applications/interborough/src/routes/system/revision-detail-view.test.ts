/** Tests for the pure mapping behind `<RevisionDetail>` (COR-1464). */
import { describe, expect, test } from 'bun:test';

import { installedRevisionSummary, revisionDetail } from './revision-detail-view.ts';
import { revisionRecord } from './workflow-revisions-panel-fixtures.test-support.ts';

describe('revisionDetail', () => {
  test('maps every field weft.workflows.revisions.get returns', () => {
    const detail = revisionDetail(revisionRecord('order-processing-rev-1'));

    expect(detail?.fields).toEqual([
      { term: 'Revision', value: 'order-processing-rev-1' },
      { term: 'Workflow name', value: 'order-processing' },
      { term: 'Workflow version', value: '0.0.0' },
      { term: 'Manifest version', value: '1' },
      { term: 'Contract hash', value: 'sha256:order-processing-rev-1-hash' },
      { term: 'Installed at', value: '2023-11-14T22:13:20.000Z' },
    ]);
  });

  test('renders the contract as indented JSON', () => {
    const detail = revisionDetail(revisionRecord('rev-1'));

    expect(detail?.contractJson).toBe(
      JSON.stringify({ name: 'order-processing', workflowVersion: '0.0.0' }, null, 2),
    );
  });

  test('rejects a payload that is not a revision record', () => {
    expect(revisionDetail(null)).toBeUndefined();
    expect(revisionDetail({ manifest: {}, installedAt: 1 })).toBeUndefined();
    expect(revisionDetail(revisionRecord('rev-1', { installedAt: 'yesterday' }))).toBeUndefined();
  });
});

describe('installedRevisionSummary', () => {
  test('names the installed workflow and revision', () => {
    expect(installedRevisionSummary(revisionRecord('rev-9'))).toEqual({
      name: 'order-processing',
      revision: 'rev-9',
    });
  });

  test('is undefined for a response that is not a revision record', () => {
    expect(installedRevisionSummary({ ok: true })).toBeUndefined();
  });
});
