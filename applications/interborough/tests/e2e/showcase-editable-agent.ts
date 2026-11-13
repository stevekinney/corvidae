/**
 * The one agent file in the showcase host, which the agent editor can open: the sample world's
 * agents are all defined in code (`00-showcase.spec.ts`, COR-2412). The sample world removes the
 * Anthropic key near its end, which empties the model catalog, so the file is written through
 * `seedSampleWorld`'s `beforeProviderKeyRemoved`, while the catalog still holds the model it names.
 */
import type { Host } from '../../src/host/host.ts';
import { E2E_SHOWCASE_EDITABLE_AGENT } from './e2e-constants.ts';

export async function createShowcaseEditableAgent(host: Host): Promise<void> {
  const created = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'showcase-editable-agent',
      method: 'bureau.agents.definitions.create',
      params: {
        id: E2E_SHOWCASE_EDITABLE_AGENT,
        definition: {
          name: 'Showcase editable agent',
          description: 'An agent file the showcase editor opens',
          model: 'anthropic/claude-sonnet-5-5',
          tools: [],
          card: [],
          instructions: 'You are an agent the showcase editor opens.',
        },
      },
    }),
  });
  const answer = (await created.json()) as { error?: { message: string } };
  if (answer.error !== undefined) {
    throw new Error(`The showcase editable agent was not created: ${answer.error.message}`);
  }
}
