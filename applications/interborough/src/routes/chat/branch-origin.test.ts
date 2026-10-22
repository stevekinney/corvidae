/**
 * "Branched from" in a branch's header: a link to the parent session, and the same words without a
 * link once the parent has been deleted.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { CHAT_COPY } from '../../app/copy.ts';
import { contextDetailFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import BranchOrigin from './branch-origin.svelte';
import QueryPage from './query-page.test-harness.svelte';

let stub: BureauStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/chat/branch-1', { replace: true });
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const mount = () =>
  render(QueryPage, {
    props: { page: BranchOrigin, pageProps: { parentId: 'parent-1' } },
  } as never);

describe('where a branch came from', () => {
  test('says so with a link to the parent session, named by its title', async () => {
    stub = installBureauStub({
      'bureau.contexts.get': () => contextDetailFixture('parent-1', { title: 'Plan the week' }),
    });

    const { findByRole, container } = mount();

    const link = await findByRole('link', { name: 'Plan the week' });
    expect(link.getAttribute('href')).toBe('/chat/parent-1');
    expect(container.textContent).toContain(CHAT_COPY.branch.branchedFrom);
    expect(stub.callsTo('bureau.contexts.get')[0]?.params).toEqual({ contextId: 'parent-1' });
    // Following the link opens the parent in the application, without a page load.
    await fireEvent.click(link);
    expect(router.pathname).toBe('/chat/parent-1');
  });

  test('leaves a modified click to the browser, which opens the link its own way', async () => {
    stub = installBureauStub({
      'bureau.contexts.get': () => contextDetailFixture('parent-1', { title: 'Plan the week' }),
    });
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('link', { name: 'Plan the week' }), { ctrlKey: true });

    expect(router.pathname).toBe('/chat/branch-1');
  });

  test('says so without a link when the parent has been deleted', async () => {
    stub = installBureauStub({
      'bureau.contexts.get': () => {
        throw new StubFault('NotFound', 404, 'No context parent-1.', { resource: 'context' });
      },
    });

    const { container, queryByRole } = mount();

    await waitFor(() => expect(container.textContent).toContain(CHAT_COPY.branch.parentDeleted));
    expect(container.textContent).toContain(CHAT_COPY.branch.branchedFrom);
    expect(queryByRole('link') === null).toBe(true);
  });

  test('still links to the parent when it could not be read for another reason', async () => {
    stub = installBureauStub({
      'bureau.contexts.get': () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
      },
    });

    const { findByRole } = mount();

    // With no title to name it, the link names the parent as an untitled chat does.
    const link = await findByRole('link', { name: CHAT_COPY.untitled });
    expect(link.getAttribute('href')).toBe('/chat/parent-1');
  });
});
