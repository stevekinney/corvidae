/**
 * The "Or chat with" row of a new chat leaves out the agent the chat is with and an agent a plugin
 * hides from Chat (COR-2233).
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import type { AgentSummary } from '../../lib/bureau-client.ts';
import NewChatChoices from './new-chat-choices.svelte';
import { AGENT } from './pages.test-support.ts';

afterEach(cleanup);

const agents = [
  { ...AGENT, name: 'tool-runner', displayName: 'Tool runner' },
  { ...AGENT, name: 'bookkeeper', displayName: 'Bookkeeper' },
  { ...AGENT, name: 'demo:internal', displayName: 'Internal', visibility: 'hidden' },
] as unknown as AgentSummary[];

describe('the other agents a new chat offers', () => {
  test('are not a hidden agent', () => {
    const { getByTestId } = render(NewChatChoices, {
      props: {
        agents,
        selected: 'tool-runner',
        blocked: false,
        onChoose: () => {},
        onExample: () => {},
      },
    } as never);

    const row = getByTestId('other-agents').textContent ?? '';
    expect(row).toContain('Bookkeeper');
    expect(row).not.toContain('Internal');
  });

  test('are every agent Chat offers when none is selected, still without a hidden one', () => {
    const { getByTestId } = render(NewChatChoices, {
      props: {
        agents,
        selected: undefined,
        blocked: false,
        onChoose: () => {},
        onExample: () => {},
      },
    } as never);

    const row = getByTestId('other-agents').textContent ?? '';
    expect(row).toContain('Tool runner');
    expect(row).toContain('Bookkeeper');
    expect(row).not.toContain('Internal');
  });
});
