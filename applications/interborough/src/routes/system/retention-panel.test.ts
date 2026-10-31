/**
 * Component tests for `<RetentionPanel>`: the retention overview that moved from the System page's
 * Health tab to Settings › Data and retention.
 */
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../../lib/query.ts';
import RetentionPanel from './retention-panel.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function renderPanel() {
  return render(SystemRouteTestHarness, {
    props: { client: realClient(), queryClient: createQueryClient(), component: RetentionPanel },
  });
}

describe('RetentionPanel', () => {
  test('renders the retention overview fields', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrl('/retention', {
      defaultRetention: null,
      sweepIntervalMs: 300000,
      sweepBatchSize: 1000,
      nextSweepAt: null,
      workflowTypes: ['order-processing'],
    });
    const { findByText, unmount } = renderPanel();
    expect(await findByText('Default retention')).not.toBeNull();
    expect(await findByText('none')).not.toBeNull();
    expect(await findByText('300000ms')).not.toBeNull();
    expect(await findByText('1000')).not.toBeNull();
    expect(await findByText('Workflow types tracked')).not.toBeNull();
    unmount();
  });

  test('a failing retention fetch shows the fault banner', async () => {
    scripted = new ScriptedFetch();
    // 403, not 500: `shouldRetryQuery` (`query.ts`) retries a classified `internal` fault with a
    // backoff this test does not wait out, and never a classified `unauthorized` one.
    scripted.routeUrlStatus('/retention', 403, 'Forbidden');
    const { findByText, unmount } = renderPanel();
    expect(await findByText('Not authorized')).not.toBeNull();
    unmount();
  });
});
