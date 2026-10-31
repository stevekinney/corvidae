/**
 * The panes of `/reviews` where they differ from the common case: a refused answer shown on the
 * field it names, an approval given no input, a question with no chat or agent to name, the
 * decision form of a workflow review with its sections and feedback, and a list that is asked again
 * after it failed (`reviews-page.test.ts` has the common case).
 */
import { HttpClient, type PendingReviewEntry } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import Harness from './reviews-shell.test-harness.svelte';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(world: Partial<BureauWorld>) {
  stub = installBureauWorld(emptyBureauWorld(world));
  router.navigate('/reviews', { replace: true });
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-review-row]')];
}

async function openFirst(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
  const row = rows(container)[0]!;
  await fireEvent.click(row.querySelector<HTMLElement>('.cinder-selectable-row__primary') ?? row);
}

describe('a refused answer', () => {
  test('is shown on the field the Bureau names, and the question stays open', async () => {
    const question = humanWaitFixture({ sessionId: 'session-2' });
    const { container, findByLabelText, findByText, getByRole } = open({ reviews: [question] });
    await openFirst(container);
    stub?.on('bureau.tasks.respond', () => {
      throw new StubFault('InvalidParams', 400, 'The answer is not valid.', {
        issues: [{ path: ['answer'], message: 'Name an environment.' }],
      });
    });
    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: 'x' } });
    await fireEvent.click(getByRole('button', { name: 'Send' }));
    await findByText('Name an environment.');
    expect(rows(container)).toHaveLength(1);
  });

  test('sends nothing for an answer that is only spaces', async () => {
    const question = humanWaitFixture({ sessionId: 'session-2' });
    const schema = { type: 'string', title: 'Your answer' };
    const { container, findByLabelText } = open({
      reviews: [{ ...question, inputSchema: schema }],
    });
    await openFirst(container);
    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: '   ' } });
    await fireEvent.submit(container.querySelector('form')!);
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });
});

describe('an approval', () => {
  test('given no input says so, rather than showing an empty list', async () => {
    const approval = toolApprovalFixture({
      requestedAt: Date.now() - 1_000,
      approval: { ...toolApprovalFixture().approval, arguments: {} },
    });
    const { container, findByText } = open({ reviews: [approval] });
    await openFirst(container);
    await findByText('This call was given no input.');
    expect(container.querySelector('.ib-tool__details')).toBeNull();
  });
});

describe('the source line', () => {
  test('names an agent that is not named, and links a question with no chat to its run', async () => {
    const question = humanWaitFixture({ agentName: undefined, runId: 'run-77' });
    const { container, findByTestId } = open({ reviews: [question] });
    await openFirst(container);
    const source = await findByTestId('review-source');
    expect(source.textContent).toContain('An agent');
    expect(source.textContent).toContain('this run');
    const links = [...source.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(links).toEqual(['/runs/run-77', '/runs/run-77']);
  });

  test('says the workflow asked, for a workflow review', async () => {
    const entry: PendingReviewEntry = {
      status: 'pending',
      reviewId: 'review-1',
      workflowId: 'wf_1',
      artifact: {},
      reviewType: 'Contract approval',
      reviewers: [],
      allowPartial: false,
      createdAt: Date.now() - 1_000,
    };
    const { container, findByTestId } = open({ weftReviews: [entry] });
    await openFirst(container);
    const source = await findByTestId('review-source');
    expect(source.textContent).toContain('a workflow');
  });
});

describe('a workflow review with sections', () => {
  test('sends each section’s decision and the feedback typed', async () => {
    const entry: PendingReviewEntry = {
      status: 'pending',
      reviewId: 'review-2',
      workflowId: 'wf_2',
      artifact: { sections: { headline: 'Ship it' } },
      reviewType: 'Copy review',
      reviewers: [],
      allowPartial: true,
      createdAt: Date.now() - 1_000,
    };
    const { container, findByRole, getByLabelText } = open({ weftReviews: [entry] });
    await openFirst(container);
    const headline = await findByRole('radiogroup', { name: 'Headline decision' });
    await fireEvent.click(headline.querySelector('input[type="radio"], [role="radio"]')!);
    await fireEvent.input(getByLabelText(/Reviewer/), { target: { value: 'ops@example.com' } });
    await fireEvent.input(getByLabelText(/Feedback/), { target: { value: 'Looks fine.' } });
    await fireEvent.click(await findByRole('button', { name: 'Submit decision' }));
    await waitFor(() => expect(stub?.weftDecisions.length).toBe(1));
    expect(stub?.weftDecisions[0]?.body).toMatchObject({
      reviewer: 'ops@example.com',
      feedback: 'Looks fine.',
      sectionDecisions: { headline: 'approved' },
    });
  });
});

describe('a list that failed', () => {
  test('is asked again by Retry, and then shows what waits', async () => {
    stub = installBureauWorld(emptyBureauWorld({ reviews: [toolApprovalFixture()] }));
    let failing = true;
    stub.on('bureau.reviews.list', () => {
      if (failing) throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
      return { reviews: [toolApprovalFixture()], nextPageToken: null };
    });
    router.navigate('/reviews', { replace: true });
    const { container, findByRole, findByText } = render(Harness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
    await findByText('The Bureau broke.');
    failing = false;
    await fireEvent.click(await findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rows(container).length).toBe(1));
  });
});
