import { describe, expect, it } from 'bun:test';

import { withoutGrantsFor } from './session-grants';

describe('withoutGrantsFor', () => {
  it('matches a grant by the tool name whatever its namespace or version, and keeps the rest', () => {
    const forgot = withoutGrantsFor(
      { approvalGrants: ['shop:issue_refund@2', 'issue_refund', 'lookup_order'], title: 'Refund' },
      ['issue_refund'],
    );

    expect(forgot.forgotten).toEqual(['shop:issue_refund@2', 'issue_refund']);
    expect(forgot.metadata).toEqual({ approvalGrants: ['lookup_order'], title: 'Refund' });
  });

  it('drops the grants entry once it holds no grant', () => {
    const forgot = withoutGrantsFor({ approvalGrants: ['issue_refund'], title: 'Refund' }, [
      'issue_refund',
    ]);

    expect(forgot.metadata).toEqual({ title: 'Refund' });
  });

  it('changes nothing for a name no grant matches, or a session with no grants', () => {
    const metadata = { approvalGrants: ['lookup_order'] };

    expect(withoutGrantsFor(metadata, ['issue_refund']).metadata).toBe(metadata);
    expect(withoutGrantsFor(metadata, ['issue_refund']).forgotten).toEqual([]);
    const none = {};
    expect(withoutGrantsFor(none, ['issue_refund']).metadata).toBe(none);
  });
});
