/**
 * The popover on an agent’s reply (COR-1983): it reads `bureau.tasks.inspect` for the reply’s step
 * when it opens, prints the plan reason and what the model saw, adds the tokens the run’s terminal
 * event reported, and leaves out what no source carries.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';
import ReplyDetails from './reply-details.svelte';
import type { RunUsage } from './run-wiring.ts';

const COPY = CHAT_COPY.replyDetails;

let stub: BureauWorldStub | undefined;

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const RECORDED = {
  step: 2,
  messageId: 'run-9:step:2',
  contextEpochId: null,
  planReason: {
    code: 'cost',
    detail: 'Two models fit and this one costs less',
    rejected: [{ provider: 'anthropic', model: 'opus', code: 'policy' }],
  },
  hasEffectiveContext: true,
  effectiveContext: {
    baselineDigest: 'sha256:0',
    sources: [{ sourceId: 'memory', trust: 'trusted', disposition: 'included' }],
    messages: [
      { id: 'm1', role: 'user', digest: 'a' },
      { id: 'm2', role: 'assistant', digest: 'b' },
    ],
    messageCount: 2,
    truncated: false,
  },
};

function mount(answer: unknown, usage?: RunUsage) {
  stub = installBureauWorld(emptyBureauWorld());
  stub.on('bureau.tasks.inspect', () => {
    if (answer instanceof StubFault) throw answer;
    return answer;
  });
  return render(QueryPage, {
    props: { page: ReplyDetails, pageProps: { runId: 'run-9', step: 2, usage } },
  } as never);
}

const trigger = (container: HTMLElement): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === COPY.action,
  );
  if (found === undefined) throw new Error('The reply details button did not render.');
  return found;
};

describe('the reply details popover', () => {
  test('reads nothing until it opens, then reads the reply’s step', async () => {
    const { container, findByTestId } = mount({ steps: [RECORDED] });
    expect(stub?.callsTo('bureau.tasks.inspect')).toHaveLength(0);

    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.querySelector('[data-part="why"]')).not.toBeNull());
    expect(stub?.callsTo('bureau.tasks.inspect').at(-1)?.params).toEqual({
      taskId: 'run-9',
      step: 2,
    });
  });

  test('prints the plan reason, the models it passed over, and what the model saw', async () => {
    const { container, findByTestId } = mount({ steps: [RECORDED] });
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.querySelector('[data-part="why"]')).not.toBeNull());

    const why = panel.querySelector('[data-part="why"]')?.textContent ?? '';
    expect(why).toContain(COPY.why);
    expect(why).toContain(COPY.planReasons.cost);
    expect(why).toContain('Two models fit and this one costs less');
    expect(why).toContain('anthropic/opus: not allowed by the model policy');
    const saw = panel.querySelector('[data-part="saw"]')?.textContent ?? '';
    expect(saw).toContain('2 messages');
    expect(saw).toContain('memory: included');
    // The run's usage was never reported to this page, so nothing is said of it.
    expect(panel.querySelector('[data-part="usage"]')).toBeNull();
  });

  test('prints no list for a plan that passed over nothing and a context with no source, and says older messages were left out', async () => {
    const { container, findByTestId } = mount({
      steps: [
        {
          ...RECORDED,
          planReason: { code: 'pinned', detail: 'The agent names its model', rejected: [] },
          effectiveContext: {
            ...RECORDED.effectiveContext,
            sources: [],
            messageCount: 1,
            truncated: true,
          },
        },
      ],
    });
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.querySelector('[data-part="saw"]')).not.toBeNull());

    expect(panel.querySelector('[data-part="why"]')?.querySelector('ul')).toBeNull();
    const saw = panel.querySelector('[data-part="saw"]');
    expect(saw?.querySelector('ul')).toBeNull();
    expect(saw?.textContent).toContain('1 message');
    expect(saw?.textContent).toContain(COPY.truncated);
  });

  test('adds the tokens the run’s terminal event reported, and only the counts it carried', async () => {
    const { container, findByTestId } = mount(
      { steps: [RECORDED] },
      { inputTokens: 1200, totalTokens: 1500 },
    );
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.querySelector('[data-part="usage"]')).not.toBeNull());

    const usage = panel.querySelector('[data-part="usage"]')?.textContent ?? '';
    expect(usage).toContain('1,200');
    expect(usage).toContain('1,500');
    expect(usage).not.toContain(COPY.usageKinds.output);
    expect(usage).toContain(COPY.usageNote);
  });

  test('leaves out the part of a step that was recorded without it', async () => {
    const { container, findByTestId } = mount(
      {
        steps: [
          { ...RECORDED, planReason: null, hasEffectiveContext: false, effectiveContext: null },
        ],
      },
      { totalTokens: 7 },
    );
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.querySelector('[data-part="usage"]')).not.toBeNull());

    expect(panel.querySelector('[data-part="why"]')).toBeNull();
    expect(panel.querySelector('[data-part="saw"]')).toBeNull();
  });

  test('says nothing was recorded for a step with no plan, no context and no usage', async () => {
    const { container, findByTestId } = mount({
      steps: [
        { ...RECORDED, planReason: null, hasEffectiveContext: false, effectiveContext: null },
      ],
    });
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.textContent).toContain(COPY.empty.title));
  });

  test('says nothing was recorded, and not that the host failed, for a step the run has no record of', async () => {
    const { container, findByTestId } = mount({ steps: [] });
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.textContent).toContain(COPY.empty.title));
    expect(panel.textContent).not.toContain(COPY.failed.title);
  });

  test('prints the run’s usage beside a step the run has no record of', async () => {
    const { container, findByTestId } = mount({ steps: [] }, { totalTokens: 42 });
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.querySelector('[data-part="usage"]')).not.toBeNull());
    expect(panel.querySelector('[data-part="usage"]')?.textContent).toContain('42');
    expect(panel.querySelector('[data-part="why"]')).toBeNull();
    expect(panel.querySelector('[data-part="saw"]')).toBeNull();
    expect(panel.textContent).not.toContain(COPY.failed.title);
  });

  test('says the details are unavailable when the Bureau cannot answer, and reads again on Try again', async () => {
    const { container, findByTestId } = mount(
      new StubFault('NotFound', 404, 'No task', { resource: 'task', identifier: 'run-9' }),
    );
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.textContent).toContain(COPY.failed.title));

    stub?.on('bureau.tasks.inspect', () => ({ steps: [RECORDED] }));
    const retry = [...panel.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === COPY.retry,
    );
    await fireEvent.click(retry as HTMLElement);
    await waitFor(() => expect(panel.querySelector('[data-part="why"]')).not.toBeNull());
  });
});
