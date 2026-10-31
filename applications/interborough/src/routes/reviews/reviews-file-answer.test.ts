/**
 * `/reviews`, a question whose answer is a file (`x-asset`): the control is drawn, the file is
 * uploaded to the Bureau's assets, and the asset's identifier is the answer. A failed upload says
 * so and keeps the review open (COR-1849).
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { humanWaitFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
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

const FILE_QUESTION = humanWaitFixture({
  sessionId: 'session-2',
  prompt: 'Attach the logo.',
  inputSchema: { type: 'string', contentMediaType: 'image/png', 'x-asset': true },
});

async function openFileQuestion() {
  stub = installBureauWorld(emptyBureauWorld({ reviews: [FILE_QUESTION] }));
  router.navigate('/reviews', { replace: true });
  const view = render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
  await waitFor(() => expect(view.container.querySelectorAll('[data-review-row]').length).toBe(1));
  const row = view.container.querySelector<HTMLElement>('[data-review-row]')!;
  await fireEvent.click(row.querySelector<HTMLElement>('.cinder-selectable-row__primary') ?? row);
  return view;
}

async function choose(container: HTMLElement, file: File): Promise<void> {
  await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await fireEvent.change(input);
}

describe('a question answered with a file', () => {
  test('shows the file input, uploads the file and sends the asset id', async () => {
    const { container } = await openFileQuestion();
    stub?.on('bureau.assets.uploads.create', () => ({ uploadId: 'upload-1' }));
    stub?.on('bureau.assets.uploads.append', () => ({}));
    stub?.on('bureau.assets.uploads.complete', () => ({
      assetId: 'asset-42',
      mediaType: 'image/png',
    }));
    stub?.on('bureau.tasks.respond', () => ({
      taskId: FILE_QUESTION.runId,
      messageId: 'm',
      reviewId: FILE_QUESTION.id,
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    }));

    await choose(container, new File(['x'], 'logo.png', { type: 'image/png' }));

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1));
    expect(stub?.callsTo('bureau.assets.uploads.complete')).toHaveLength(1);
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      taskId: FILE_QUESTION.runId,
      answer: 'asset-42',
    });
  });

  test('says so when the upload fails, sends nothing, and keeps the review open', async () => {
    const { container } = await openFileQuestion();
    stub?.on('bureau.assets.uploads.create', () => {
      throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
    });

    await choose(container, new File(['x'], 'logo.png', { type: 'image/png' }));

    await waitFor(() => expect(stub?.callsTo('bureau.assets.uploads.create').length).toBe(1));
    await waitFor(() =>
      expect(container.querySelector('.chat-question-error[role="alert"]')).not.toBeNull(),
    );
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
    expect(container.querySelectorAll('[data-review-row]')).toHaveLength(1);
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });
});
