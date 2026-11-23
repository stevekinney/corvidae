/**
 * What a run cost, in a reply's details (COR-2525): the popover prints the cost beside the tokens
 * when the run's terminal event carried one, writes an amount under one cent as `< $0.01`, and
 * prints nothing at all for a run that has no cost, never `$0.00`.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
import { COST_COPY } from '../../app/copy/cost.ts';
import { createQueryClient } from '../../lib/query.ts';
import { bureau } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';
import ReplyDetails from './reply-details.svelte';
import type { RunUsage } from './run-wiring.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const COPY = CHAT_COPY.replyDetails;

const STEP = {
  step: 1,
  messageId: 'run-1:step:1',
  contextEpochId: null,
  planReason: { code: 'pinned', detail: 'The agent names its model', rejected: [] },
  hasEffectiveContext: false,
  effectiveContext: null,
};

async function openDetails(usage: RunUsage | undefined): Promise<HTMLElement> {
  const served = bureau({ 'bureau.tasks.inspect': () => ({ steps: [STEP] }) });
  restore = served.restore;
  const { container, findByTestId } = render(QueryPage, {
    props: {
      page: ReplyDetails,
      pageProps: { runId: 'run-1', step: 1, ...(usage === undefined ? {} : { usage }) },
      client: createQueryClient(),
    },
  } as never);
  const trigger = [...container.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === COPY.action,
  );
  if (trigger === undefined) throw new Error('The reply offers no details.');
  await fireEvent.click(trigger);
  const panel = await findByTestId('reply-details');
  await waitFor(() => expect(panel.textContent).toContain(COPY.planReasons.pinned));
  return panel;
}

describe('the cost in a reply’s details', () => {
  test('AC1: reads the run’s cost beside its tokens', async () => {
    const panel = await openDetails({ totalTokens: 1200, costUsd: 0.1234 });

    expect(panel.querySelector('[data-part="usage"]')?.textContent).toContain(COST_COPY.label);
    expect(panel.querySelector('[data-testid="reply-cost"]')?.textContent).toBe('$0.12');
    expect(panel.textContent).toContain('1,200');
  });

  test('AC5: says a cost under one cent as `< $0.01`', async () => {
    const panel = await openDetails({ totalTokens: 40, costUsd: 0.002 });

    expect(panel.querySelector('[data-testid="reply-cost"]')?.textContent).toBe('< $0.01');
  });

  test('AC4: prints no cost for a run with none, and never `$0.00`', async () => {
    const withTokens = await openDetails({ totalTokens: 1200 });

    expect(withTokens.querySelector('[data-testid="reply-cost"]')).toBeNull();
    expect(withTokens.textContent).not.toContain(COST_COPY.label);
    expect(withTokens.textContent).not.toContain('$');
  });

  test('AC4: prints no usage section at all for a run the page did not watch end', async () => {
    const panel = await openDetails(undefined);

    expect(panel.querySelector('[data-part="usage"]')).toBeNull();
    expect(panel.textContent).not.toContain('$');
  });
});
