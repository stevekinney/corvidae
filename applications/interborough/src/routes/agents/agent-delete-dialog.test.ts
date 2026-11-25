import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, expect, test } from 'bun:test';

import { installBureauStub } from '../../lib/bureau-stub.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDeleteDialog from './agent-delete-dialog.svelte';

let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

test('requires the identifier, holds its failure inline, and leaves Delete agent armed for retry', async () => {
  restore = installBureauStub({
    'bureau.agents.references': () => ({
      schedules: [],
      workflows: [{ id: 'order-refund', title: 'Order refund' }],
      hooks: [],
    }),
    'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
  }).restore;
  let confirms = 0;
  const { findByRole } = render(QueryPage, {
    props: {
      page: AgentDeleteDialog,
      pageProps: {
        open: true,
        id: 'researcher',
        name: 'Researcher',
        error: 'The disk is full.',
        onConfirm: () => (confirms += 1),
      },
    },
  } as never);

  const dialog = await findByRole('dialog', { name: 'Delete Researcher?' });
  const confirm = within(dialog).getByRole('button', { name: 'Delete agent' });
  expect(confirm.hasAttribute('disabled')).toBe(true);
  await waitFor(() =>
    expect(dialog.textContent).toContain('1 workflow (Order refund) will stop finding it.'),
  );
  expect(within(dialog).getByRole('alert').textContent).toContain('The disk is full.');

  await fireEvent.input(within(dialog).getByLabelText('Type researcher to confirm'), {
    target: { value: 'researcher' },
  });
  await fireEvent.click(confirm);
  expect(confirms).toBe(1);
  expect(await findByRole('dialog', { name: 'Delete Researcher?' })).not.toBeNull();
});

test('renders Deleting and ignores another confirmation while the request is held', async () => {
  restore = installBureauStub({
    'bureau.agents.references': () => ({ schedules: [], workflows: [], hooks: [] }),
    'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
  }).restore;
  let confirms = 0;
  const { findByRole } = render(QueryPage, {
    props: {
      page: AgentDeleteDialog,
      pageProps: {
        open: true,
        id: 'researcher',
        name: 'Researcher',
        busy: true,
        onConfirm: () => (confirms += 1),
      },
    },
  } as never);

  const dialog = await findByRole('dialog', { name: 'Delete Researcher?' });
  const confirm = within(dialog).getByRole('button', { name: 'Deleting…' });
  await fireEvent.click(confirm);
  expect(confirms).toBe(0);
});
