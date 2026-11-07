/**
 * The agent picker at the top of a new chat's composer (design row 24v): an agent with no
 * description shows its name and, muted beside it, that it has none.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import type { AgentSummary } from '../../lib/bureau-client.ts';
import AgentSelect from './agent-select.svelte';
import { openListbox } from './listbox.test-support.ts';
import { AGENT } from './pages.test-support.ts';

afterEach(cleanup);

describe('the agent picker', () => {
  test('says "no description" beside the name of an agent that has none, and shows the sentence of one that has', async () => {
    const agents = [
      {
        ...AGENT,
        name: 'tool-runner',
        displayName: 'Tool runner',
        description: 'Looks orders up.',
      },
      { ...AGENT, name: 'nightly-archiver', displayName: 'Nightly archiver', description: null },
    ] as unknown as AgentSummary[];
    const { container } = render(AgentSelect, {
      props: { agents, value: 'tool-runner', providerConnected: true, onChange: () => {} },
    } as never);

    const rows = await openListbox(container, 'weft-chat-agent');

    const text = (name: string) =>
      rows.find((row) => row.textContent?.includes(name))?.textContent?.replaceAll(/\s+/g, ' ');
    expect(text('Tool runner')).toContain('Looks orders up.');
    expect(text('Nightly archiver')).toContain('no description');
  });
});
