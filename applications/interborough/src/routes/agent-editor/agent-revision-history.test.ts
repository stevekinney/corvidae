/**
 * The revision history: the versions of an agent that have run, each by its short hash and its
 * last-run time, in the order the Bureau lists them (most recently run first). A save that never
 * ran is not a row, because the Bureau does not list it.
 */
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import {
  installBureauStub,
  revisionFixture,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import Harness from './agent-revision-history-test-harness.test-harness.svelte';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const copy = AGENT_EDITOR_COPY.revisions;

describe('the revision history', () => {
  test('lists each version by its short hash and its last-run time, most recently run first', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.revisions': () => ({
        revisions: [
          revisionFixture('f00dfeedcafebabe0123456789', '2026-10-19T12:00:00.000Z'),
          revisionFixture('1234567890abcdef', '2026-10-18T09:30:00.000Z'),
        ],
      }),
    });
    const { findAllByTestId, getByRole } = render(Harness, { props: { id: 'researcher' } });
    const rows = await findAllByTestId('agent-revision');

    expect(stub.calls).toEqual([
      { method: 'bureau.agents.definitions.revisions', params: { id: 'researcher' } },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('code')?.textContent).toBe('f00dfeed');
    expect(rows[0]?.querySelector('code')?.getAttribute('title')).toBe(
      'f00dfeedcafebabe0123456789',
    );
    expect(rows[0]?.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-19T12:00:00.000Z',
    );
    expect(rows[1]?.querySelector('code')?.textContent).toBe('12345678');
    expect(rows[1]?.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-18T09:30:00.000Z',
    );
    expect(getByRole('heading', { level: 2, name: copy.heading })).not.toBeNull();
    expect(getByRole('table', { name: copy.caption })).not.toBeNull();
  });

  test('says so when no version has run', async () => {
    stub = installBureauStub({ 'bureau.agents.definitions.revisions': () => ({ revisions: [] }) });
    const { findByTestId, queryByRole } = render(Harness, { props: { id: 'researcher' } });
    const empty = await findByTestId('agent-revisions-empty');
    expect(empty.textContent).toContain(copy.empty);
    expect(queryByRole('table')).toBeNull();
  });

  test('is loading until the Bureau answers', () => {
    stub = installBureauStub({
      'bureau.agents.definitions.revisions': () => new Promise<never>(() => {}),
    });
    const { container } = render(Harness, { props: { id: 'researcher' } });
    expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
  });

  test('says the history could not be loaded when the Bureau fails', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.revisions': () => {
        throw new StubFault('EngineFailure', 500, 'Down.');
      },
    });
    const { findByRole } = render(Harness, { props: { id: 'researcher' } });
    const alert = await findByRole('alert');
    expect(alert.textContent).toContain(copy.failedTitle);
  });
});
