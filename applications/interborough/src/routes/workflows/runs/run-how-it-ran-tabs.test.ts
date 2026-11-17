/**
 * COR-2424, row 54i: How it ran holds tabs, Steps first, then Inspector, Raw payloads and Events
 * and logs, and Versioning and Search attributes only when the page gives them something.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import RunHowItRanTabs from './run-how-it-ran-tabs.svelte';

afterEach(() => cleanup());

const panel = (name: string) =>
  createRawSnippet(() => ({ render: () => `<p data-section="${name}">${name} panel</p>` }));

describe('the tabs of How it ran', () => {
  test('lists Steps, Inspector, Raw payloads and Events and logs, and opens on Steps', () => {
    const view = render(RunHowItRanTabs, {
      props: {
        steps: panel('activity'),
        inspector: panel('run-inspector'),
        raw: panel('raw-payloads'),
        events: panel('engine-history'),
      },
    });
    const tabs = view.getAllByRole('tab').map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(['Steps', 'Inspector', 'Raw payloads', 'Events and logs']);
    expect(view.container.querySelector('[data-section="activity"]')).not.toBeNull();
    expect(view.container.querySelector('[data-section="run-inspector"]')).toBeNull();
  });

  test('draws Versioning and Search attributes only when given them, and no bar for Steps alone', () => {
    const without = render(RunHowItRanTabs, { props: { steps: panel('activity') } });
    expect(without.queryAllByRole('tab')).toHaveLength(0);
    expect(without.container.querySelector('[data-section="activity"]')).not.toBeNull();
    cleanup();

    const withBoth = render(RunHowItRanTabs, {
      props: {
        steps: panel('activity'),
        versioning: panel('versioning'),
        attributes: panel('engine-panels'),
      },
    });
    expect(withBoth.getByRole('tab', { name: 'Versioning' })).not.toBeNull();
    expect(withBoth.getByRole('tab', { name: 'Search attributes' })).not.toBeNull();
  });

  test('keeps each panel’s data-section on the panel its tab opens', async () => {
    const view = render(RunHowItRanTabs, {
      props: { steps: panel('activity'), inspector: panel('run-inspector') },
    });
    await fireEvent.click(view.getByRole('tab', { name: 'Inspector' }));
    expect(view.container.querySelector('[data-section="run-inspector"]')).not.toBeNull();
    expect(view.container.querySelector('[data-section="activity"]')).toBeNull();
  });
});
