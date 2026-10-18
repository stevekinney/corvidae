/** The placeholder a later issue replaces: it names the view the route belongs to. */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import Placeholder from './index.svelte';

function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

describe('the placeholder route', () => {
  test('says the view it stands in for is not built yet', () => {
    landAt('/agents');
    const { getByRole, getByText } = render(Placeholder);
    expect(getByRole('heading', { level: 1, name: 'Agents' })).not.toBeNull();
    expect(getByText('Agents is not built yet.')).not.toBeNull();
  });

  test('falls back to a generic name when no route matches', () => {
    landAt('/nowhere');
    const { getByRole } = render(Placeholder);
    expect(getByRole('heading', { level: 1, name: 'This view' })).not.toBeNull();
  });
});
