/**
 * The Health overview's recent-activity window: it starts from what the fleet feed already saw
 * (so a page opened late is not empty), holds six lines, collapses repeats into one line with a
 * count, and ends in a link to the audit log. The feed is a double of the shell's one source.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  FleetEventSource,
  type FleetEventFrame,
} from '../../lib/live-source/fleet-event-source.svelte.ts';
import { router } from '../../lib/router.svelte.ts';
import Harness from './activity-feed-band-test-harness.test-harness.svelte';

/** A fleet source that has already seen `frames`, and connects to nothing. */
class SeenSource extends FleetEventSource {
  readonly #seen: readonly FleetEventFrame[];

  constructor(seen: readonly FleetEventFrame[]) {
    super({ baseUrl: '' });
    this.#seen = seen;
  }

  override recent(): readonly FleetEventFrame[] {
    return this.#seen;
  }

  override subscribe(): () => void {
    return () => {};
  }
}

function frame(sequence: number, kind: string): FleetEventFrame {
  return {
    kind,
    workflowId: `wf_${String(sequence)}`,
    sequence,
    cursor: String(sequence),
    emittedAtMs: Date.now() - 1_000 * (100 - sequence),
    payload: {},
  };
}

describe('the recent-activity window', () => {
  test('starts from the frames the feed already saw instead of from nothing', () => {
    const source = new SeenSource([frame(1, 'alert:fired'), frame(2, 'workflow:failed')]);
    const { getByText, queryByText } = render(Harness, { props: { source } });

    expect(getByText('Alert fired')).not.toBeNull();
    expect(getByText('Workflow failed')).not.toBeNull();
    expect(queryByText('Nothing has happened yet')).toBeNull();
    source.close();
  });

  test('holds six lines, the latest first', () => {
    const kinds = [
      'alert:fired',
      'alert:resolved',
      'workflow:started',
      'workflow:failed',
      'worker:connected',
      'worker:disconnected',
      'workflow:cancelled',
      'workflow:suspended',
    ];
    const source = new SeenSource(kinds.map((kind, index) => frame(index + 1, kind)));
    const { container } = render(Harness, { props: { source } });

    const lines = container.querySelectorAll('.weft-activity-feed__row');
    expect(lines).toHaveLength(6);
    expect(lines[0]?.textContent).toContain('Workflow suspended');
    expect(lines[5]?.textContent).toContain('Workflow started');
    source.close();
  });

  test('collapses repeats in a row into one line with a count', () => {
    const source = new SeenSource([
      frame(1, 'alert:fired'),
      frame(2, 'workflow:completed'),
      frame(3, 'workflow:completed'),
      frame(4, 'workflow:completed'),
    ]);
    const { container, getByText } = render(Harness, { props: { source } });

    expect(getByText('Workflow completed ×3', { exact: false })).not.toBeNull();
    expect(container.querySelectorAll('.weft-activity-feed__row')).toHaveLength(2);
    source.close();
  });

  test('says so, with an empty state, when nothing has happened', () => {
    const source = new SeenSource([]);
    // A closed source is not connecting, so the window is settled and empty.
    const { getByText } = render(Harness, { props: { source } });

    expect(getByText('Nothing has happened yet')).not.toBeNull();
    source.close();
  });

  test('ends in a link to the audit log, opened in place', async () => {
    const source = new SeenSource([frame(1, 'alert:fired')]);
    const { getByRole } = render(Harness, { props: { source } });

    const link = getByRole('link', { name: 'Open the audit log' });
    expect(link.getAttribute('href')).toBe('/health/audit');
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/health/audit');
    source.close();
  });
});
