/// <reference lib="dom" />
import { afterEach, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render, waitFor } = await import('@testing-library/svelte');
const { default: StreamingExample } = await import('./transcript-streaming.example.svelte');
const { default: CallDoneExample } =
  await import('./transcript-streaming-call-done.example.svelte');
const { default: SettingNoteExample } = await import('./composer-setting-note.example.svelte');

afterEach(cleanup);

/** The transcript's message rows and rail rows in document order, naming each. */
function rowOrder(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>('.chat-message, .cinder-tool-call-rail__item'),
  ].map((element) =>
    element.matches('.chat-message') ? `message: ${element.textContent ?? ''}` : 'rail',
  );
}

for (const [name, mount, user, reply] of [
  [
    'a running call',
    () => render(StreamingExample),
    'Also look up order 4398, the same carrier.',
    'Looking up order 4398',
  ],
  [
    'a finished call',
    () => render(CallDoneExample),
    'Also look up order 4398, the same carrier.',
    'Order 4398 is $27.25',
  ],
  [
    'the setting note',
    () => render(SettingNoteExample),
    'Also look up order 4398, the same carrier.',
    'Order 4398 is $27.25',
  ],
] as const) {
  test(`${name}: the rail sits under the user message and above the reply`, async () => {
    const { container } = mount();

    await waitFor(() => {
      const order = rowOrder(container);
      expect(order).toHaveLength(3);
      expect(order[0]).toContain(user);
      expect(order[1]).toBe('rail');
      expect(order[2]).toContain(reply);
    });
  });
}

test('the setting note draws its reply in the transcript presentation, not a boxed bubble', async () => {
  const { container } = render(SettingNoteExample);

  await waitFor(() => expect(container.querySelector('.chat-message')).not.toBeNull());
  const replies = container.querySelectorAll('.chat-message-wrapper[data-role="assistant"]');
  expect(replies).toHaveLength(1);
  expect(replies[0]?.getAttribute('data-presentation')).toBe('transcript');
});
