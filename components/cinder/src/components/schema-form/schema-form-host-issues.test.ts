/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');

// load-proof: Svelte effects and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const schema = {
  type: 'object',
  properties: {
    room: { type: 'string', title: 'Room' },
    size: { type: 'integer', title: 'Size' },
  },
};

describe('SchemaForm host-reported issues', () => {
  afterEach(() => cleanup());

  test('shows an issue on the field its path names and leaves the others valid', async () => {
    render(SchemaForm, {
      props: { schema, issues: [{ path: ['room'], message: 'Room is already booked' }] },
    });
    await flush();

    const room = screen.getByLabelText(/Room/);
    expect(room.getAttribute('aria-invalid')).toBe('true');
    const errorId = room
      .getAttribute('aria-describedby')
      ?.split(' ')
      .find((id) => id.includes('error'));
    expect(document.getElementById(errorId ?? '')?.textContent).toContain('Room is already booked');
    expect(screen.getByRole('spinbutton', { name: /Size/ }).getAttribute('aria-invalid')).not.toBe(
      'true',
    );
  });

  test('a new set of issues replaces the last, and editing the field clears its issue', async () => {
    const view = render(SchemaForm, {
      props: { schema, issues: [{ path: ['room'], message: 'Room is already booked' }] },
    });
    await flush();

    await view.rerender({ issues: [{ path: ['size'], message: 'Size is too large' }] });
    await flush();
    expect(screen.getByRole('spinbutton', { name: /Size/ }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(screen.getByLabelText(/Room/).getAttribute('aria-invalid')).not.toBe('true');

    await fireEvent.input(screen.getByRole('spinbutton', { name: /Size/ }), {
      target: { value: '3' },
    });
    await fireEvent.blur(screen.getByRole('spinbutton', { name: /Size/ }));
    await flush();
    expect(screen.getByRole('spinbutton', { name: /Size/ }).getAttribute('aria-invalid')).not.toBe(
      'true',
    );
  });

  test('a string marked writeOnly is a password field', async () => {
    render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: { token: { type: 'string', title: 'Token', writeOnly: true } },
        },
      },
    });
    await flush();

    expect((screen.getByLabelText(/Token/) as HTMLInputElement).type).toBe('password');
  });
});
