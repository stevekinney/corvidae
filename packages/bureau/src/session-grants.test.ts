import { describe, expect, it } from 'bun:test';

import { withoutGrantsFor } from './session-grants';

describe('withoutGrantsFor', () => {
  it('matches a grant by its tool whatever its version, and keeps the rest', () => {
    const forgot = withoutGrantsFor(
      {
        approvalGrants: ['default:issue_refund@2', 'issue_refund', 'lookup_order'],
        title: 'Refund',
      },
      ['issue_refund'],
    );

    expect(forgot.forgotten).toEqual(['default:issue_refund@2', 'issue_refund']);
    expect(forgot.metadata).toEqual({ approvalGrants: ['lookup_order'], title: 'Refund' });
  });

  it.each([
    ['the provider’s name a stored call carries', 'shop__issue-refund'],
    ['the name a result reports', 'shop:issue-refund'],
    ['an id of another version', 'shop:issue-refund@2.0.0'],
  ])('matches a namespaced tool’s grant by %s', (_form, name) => {
    const forgot = withoutGrantsFor(
      { approvalGrants: ['shop:issue-refund@1.0.0', 'shop:issue-refund', 'shop:lookup-order@1'] },
      [name],
    );

    expect(forgot.forgotten).toEqual(['shop:issue-refund@1.0.0', 'shop:issue-refund']);
    expect(forgot.metadata).toEqual({ approvalGrants: ['shop:lookup-order@1'] });
  });

  it('keeps the grant of another namespace’s tool of the same name', () => {
    const metadata = { approvalGrants: ['shop:issue-refund@1.0.0', 'bank__issue-refund'] };

    expect(withoutGrantsFor(metadata, ['issue-refund']).forgotten).toEqual([]);
    expect(withoutGrantsFor(metadata, ['bank:issue-refund']).forgotten).toEqual([
      'bank__issue-refund',
    ]);
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
