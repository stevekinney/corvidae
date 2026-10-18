/**
 * The boot failure: no sign-in form, only a reload button.
 */
import { render } from '@testing-library/svelte';
import { expect, spyOn, test } from 'bun:test';

import BootFailure from './boot-failure.svelte';

test('an unidentified caller sees a reload button, never a place to type a key', async () => {
  const { container, findByRole, queryByLabelText } = render(BootFailure);

  expect(
    await findByRole('heading', { level: 1, name: 'Interborough could not identify you' }),
  ).not.toBeNull();
  expect(container.querySelector('[data-view="boot"][data-state="error"]')).not.toBeNull();
  expect(queryByLabelText(/api key/i)).toBeNull();
  expect(container.querySelector('input')).toBeNull();

  const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
  try {
    const button = await findByRole('button', { name: 'Reload' });
    button.click();
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    reload.mockRestore();
  }
});
