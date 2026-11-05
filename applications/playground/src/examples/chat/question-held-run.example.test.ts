/// <reference lib="dom" />
import { afterEach, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render, waitFor } = await import('@testing-library/svelte');
const { default: QuestionHeldRunExample } = await import('./question-held-run.example.svelte');

afterEach(cleanup);

test('shows the run page’s words for a held answer: Selected under the pick, one inline line with Undo and the note', async () => {
  const { container } = render(QuestionHeldRunExample);

  await waitFor(() => {
    const status = container.querySelector('.chat-question-status[data-state="held"]');
    expect(status?.textContent).toContain('Answer sent: Production. Undo for 5 s.');
    expect(status?.textContent).toContain(
      'Request human input continues once a provider is connected.',
    );
    expect(status?.querySelector('button')?.textContent?.trim()).toBe('Undo');
  });

  const choices = [...container.querySelectorAll<HTMLElement>('.chat-question-choices button')];
  const picked = choices.filter((choice) => choice.hasAttribute('data-selected'));
  expect(picked).toHaveLength(1);
  expect(picked[0]?.textContent).toContain('Production');
  expect(picked[0]?.textContent).toContain('Selected');
  const others = choices.filter((choice) => !choice.hasAttribute('data-selected'));
  expect(others[0]?.textContent).toContain('Staging');
  expect(others[0]?.textContent).not.toContain('Deploys to the staging site');
  expect(container.querySelectorAll('.chat-question-status')).toHaveLength(1);
});
