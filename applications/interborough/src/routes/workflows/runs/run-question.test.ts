/**
 * A run that waits on a question (COR-2014): the page puts "What you can do" first, over a card
 * that says who asked and how long ago, with the choices side by side and the payload's own
 * descriptions. A picked choice is held for five seconds with Undo in one line on the card and in
 * the run's status line, and the run is told the answer when the window ends.
 */
import { HttpClient } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { setAnswerUndoMilliseconds } from '../../../lib/answer-undo.ts';
import { humanWaitFixture, taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;
let restoreWindow: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restoreWindow?.();
  restoreWindow = undefined;
  if (jest.isFakeTimers()) {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
  stub?.restore();
  stub = undefined;
});

const REVIEW_ID = 'human-wait:run-1:environment:0';

function open(models: readonly unknown[]) {
  const task = taskFixture({
    id: 'run-1',
    agentName: 'request-human-input',
    status: 'input-required',
    openWaits: [{ kind: 'human-wait', reviewId: REVIEW_ID, signalName: 'environment' }],
  });
  stub = installBureauWorld(
    emptyBureauWorld({
      tasks: [task],
      reviews: [
        humanWaitFixture({
          id: REVIEW_ID,
          runId: 'run-1',
          requestedAt: Date.now() - 3_600_000,
          inputSchema: {
            anyOf: [{ enum: ['staging', 'production'] }, { type: 'string', maxLength: 500 }],
            'x-allowOther': true,
            'x-labels': { staging: 'Staging', production: 'Production' },
            'x-descriptions': {
              staging: 'Deploys to the staging site',
              production: 'Deploys to the live site',
            },
          },
        }),
      ],
    }),
  );
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({
    agents: [
      {
        name: 'request-human-input',
        displayName: 'Request human input',
        description: null,
        definitionRevision: 1,
        kind: 'code',
        a2a: false,
      },
    ],
  }));
  stub.on('bureau.agents.catalog', () => ({ models, tools: [], skills: [] }));
  stub.on('bureau.tasks.respond', (params) => ({
    taskId: 'run-1',
    messageId: params['messageId'],
    reviewId: REVIEW_ID,
    kind: 'human-wait',
    decision: 'approve',
    receipt: 'applied',
  }));
  landAt('/runs/run-1');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      queryClient: new QueryClient(),
    },
  } as never);
}

/** Moves the fake clock, then lets the promise continuations that follow settle. */
async function elapse(milliseconds: number): Promise<void> {
  jest.advanceTimersByTime(milliseconds);
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

describe('the question card on a run waiting for you', () => {
  test('leads the page under "What you can do", with who asked, how long ago, and the choices', async () => {
    restoreWindow = setAnswerUndoMilliseconds(5000);
    const view = open([]);

    expect(await view.findByText('What you can do')).not.toBeNull();
    expect(view.getByText('This run is waiting on one question.')).not.toBeNull();
    expect(await view.findByText('Question from Request human input · 1 h ago')).not.toBeNull();
    expect(view.getByText('Which environment should the release go to?')).not.toBeNull();
    expect(view.getByText('Deploys to the staging site')).not.toBeNull();
    expect(view.getByText('Deploys to the live site')).not.toBeNull();
    // It says what choosing does, and, with no provider, when the run goes on.
    expect(
      view.getByText(/Choosing an answer sends it at once\. The run waits 5 seconds/),
    ).not.toBeNull();
    expect(view.container.querySelector('.ib-run-wait__note')?.textContent).toContain(
      'Request human input continues once a provider is connected.',
    );
  });

  test('with no provider the message bar is the blocked row with Cancel run beside it, and no text box', async () => {
    const view = open([]);
    await view.findByText('Question from Request human input · 1 h ago');

    const bar = await view.findByTestId('run-message-blocked');
    expect(bar.textContent).toContain('Connect a model provider to send messages');
    expect(bar.querySelector('[data-chat-composer-status="blocked"]')).not.toBeNull();
    expect(bar.querySelector('textarea')).toBeNull();
    const connect = bar.querySelector('a')!;
    expect(connect.textContent?.trim()).toBe('Connect a provider');
    expect(connect.getAttribute('href')).toBe('/settings/models');
    const buttons = [...bar.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(buttons).toContain('Cancel run');
  });

  test('has no blocked message bar when a provider is connected', async () => {
    const view = open([{ provider: 'anthropic', id: 'sonnet' }]);
    await view.findByText('Question from Request human input · 1 h ago');
    expect(view.queryByTestId('run-message-blocked')).toBeNull();
  });

  test('says nothing about a provider when one is connected', async () => {
    const view = open([{ provider: 'anthropic', id: 'sonnet' }]);
    await view.findByText('Question from Request human input · 1 h ago');
    expect(view.container.textContent).not.toContain('continues once a provider is connected');
  });

  test('holds a picked choice with one inline line, the status line says so, and Undo takes it back', async () => {
    restoreWindow = setAnswerUndoMilliseconds(5000);
    const view = open([]);
    const production = await view.findByRole('button', { name: /Production/ });
    await view.findByText('Question from Request human input · 1 h ago');
    jest.useFakeTimers();

    await fireEvent.click(production);

    expect(view.container.querySelector('.chat-question-status')?.textContent).toContain(
      'Answer sent: Production. Undo for 5 s.',
    );
    expect(view.container.querySelector('.chat-question-status')?.textContent).toContain(
      'Request human input continues once a provider is connected.',
    );
    expect(view.container.querySelector('[data-run-header]')?.textContent).toContain(
      'answer sent, undo for 5 s',
    );
    expect(production.getAttribute('aria-pressed')).toBe('true');
    // The chosen button reads "Selected" in place of its description; the other keeps its label only.
    expect(production.textContent).toContain('Selected');
    expect(view.getByRole('button', { name: /Staging/ }).textContent).not.toContain(
      'Deploys to the staging site',
    );
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);

    await fireEvent.click(view.getByRole('button', { name: 'Undo' }));
    await elapse(20000);
    expect(view.container.querySelector('.chat-question-status')).toBeNull();
    expect(view.container.querySelector('[data-run-header]')?.textContent).not.toContain(
      'answer sent',
    );
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });

  test('tells the run the answer when the five seconds end', async () => {
    restoreWindow = setAnswerUndoMilliseconds(5000);
    const view = open([]);
    const staging = await view.findByRole('button', { name: /Staging/ });
    await view.findByText('Question from Request human input · 1 h ago');
    jest.useFakeTimers();

    await fireEvent.click(staging);
    await elapse(5100);
    jest.useRealTimers();

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      taskId: 'run-1',
      answer: 'staging',
      signalName: 'environment',
    });
    await waitFor(() =>
      expect(view.container.querySelector('[data-run-header]')?.textContent).not.toContain(
        'answer sent',
      ),
    );
  });
});
