/**
 * What the audit log says when it has no event to list (rows 82t, 82w, 83e and 83h): the sentence
 * of a failed read, the sentence of filters that match nothing, and the one of a failed export.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { AUDIT_COPY } from '../../app/copy.ts';
import { EMPTY_AUDIT_DRAFT, type AuditDraft } from './audit-filter.ts';
import { auditExportFailure, auditLoadFailure, auditNoMatches } from './audit-states.ts';

const draft = (overrides: Partial<AuditDraft>): AuditDraft => ({
  ...EMPTY_AUDIT_DRAFT,
  ...overrides,
});

describe('auditLoadFailure', () => {
  test('names the status a server error answered with, and that nothing the person did caused it', () => {
    const failure = auditLoadFailure(new HttpClientError(500, 'Broke.'));

    expect(failure.title).toBe('Couldn’t load the audit log');
    expect(failure.description).toBe(
      'The server answered with an error (500). Nothing you did caused it.',
    );
  });

  test('carries the server’s own words for a refusal, which is something to fix', () => {
    const failure = auditLoadFailure(new HttpClientError(403, 'Not yours.'));

    expect(failure.description).toBe('The server answered with an error (403): Not yours.');
  });

  test('says the server did not answer when no response came back', () => {
    expect(auditLoadFailure(new TypeError('fetch failed')).description).toBe(
      AUDIT_COPY.failed.noAnswer,
    );
  });

  test('says something went wrong for a failure that is neither', () => {
    expect(auditLoadFailure(new Error('odd')).description).toBe(AUDIT_COPY.failed.unknown);
  });
});

describe('auditExportFailure', () => {
  test('says the server stopped while writing the file, and that nothing was downloaded', () => {
    expect(auditExportFailure(new HttpClientError(503, 'Down.'))).toBe(
      'The server stopped while writing the file. Your filters are unchanged; nothing was downloaded.',
    );
  });

  test('says the server did not answer when no response came back', () => {
    expect(auditExportFailure(new TypeError('fetch failed'))).toBe(
      'The server didn’t answer. Your filters are unchanged; nothing was downloaded.',
    );
  });
});

describe('auditNoMatches', () => {
  test('Agents and Today say what was not recorded, and to try a longer period', () => {
    expect(auditNoMatches(draft({ actor: 'agents', period: 'today' }))).toEqual({
      title: 'No events match these filters',
      description: 'Nothing by agents was recorded today. Try a longer period.',
    });
  });

  test('puts the action before who, and the period last', () => {
    expect(
      auditNoMatches(draft({ actor: 'you', action: 'approved', period: '30d' })).description,
    ).toBe('Nothing approved by you was recorded in the last 30 days. Try a longer period.');
    expect(auditNoMatches(draft({ actor: 'interborough' })).description).toBe(
      'Nothing by Interborough was recorded in the last 7 days. Try a longer period.',
    );
  });

  test('a period with nothing set besides it says only when', () => {
    expect(auditNoMatches(draft({ period: 'today' })).description).toBe(
      'Nothing was recorded today. Try a longer period.',
    );
  });

  test('suggests another filter once the period cannot reach further back', () => {
    expect(auditNoMatches(draft({ action: 'removed', period: '90d' })).description).toBe(
      'Nothing removed was recorded in the last 90 days. Try all time, or change a filter.',
    );
    expect(auditNoMatches(draft({ actor: 'agents', period: 'all' })).description).toBe(
      'Nothing by agents has been recorded. Change or clear a filter.',
    );
  });

  test('a search names itself in the title and says how to search, whatever else is set', () => {
    expect(auditNoMatches(draft({ text: 'refund 9999' }))).toEqual({
      title: 'No events match “refund 9999”',
      description: 'Check the spelling, or search by actor, action or target.',
    });
    expect(auditNoMatches(draft({ text: '  refund 9999 ', actor: 'agents' })).title).toBe(
      'No events match “refund 9999”',
    );
  });

  test('a search too long for a heading ends with an ellipsis', () => {
    const title = auditNoMatches(draft({ text: 'x'.repeat(300) })).title;

    expect(title).toBe(`No events match “${'x'.repeat(80)}…”`);
  });

  test('a blank search is no search', () => {
    expect(auditNoMatches(draft({ text: '   ', period: 'today' })).title).toBe(
      'No events match these filters',
    );
  });
});
