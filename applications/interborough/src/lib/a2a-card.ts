/**
 * An agent's public A2A Agent Card, read from the host (`/bureau/a2a/<agent>/.well-known/agent-card.json`,
 * COR-1819). The card names the address a caller reaches the agent at: the host's own, or the
 * public origin a reverse proxy serves A2A at when the operator set one (COR-1904). The browser
 * cannot know that origin, so it reads it from the card, which is public and needs no key.
 */
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';

const cardSchema = z.object({
  supportedInterfaces: z.array(z.object({ url: z.string().min(1) })).min(1),
  securitySchemes: z.record(z.string(), z.unknown()).optional(),
});

/** What the A2A section shows of a card: where it is served, where the agent is called, and whether a caller needs a key. */
export type AgentCardSummary = {
  /** The address of the card itself. */
  readonly cardUrl: string;
  /** The address an A2A client sends its calls to. */
  readonly agentUrl: string;
  /** Whether the card declares a security scheme, so a caller must present the operator's key. */
  readonly needsKey: boolean;
};

/** The path of an agent's card on the host. */
export function agentCardPath(agent: string): string {
  return `/bureau/a2a/${encodeURIComponent(agent)}/.well-known/agent-card.json`;
}

/**
 * Reads an agent's card. The card address shown is the card's own interface address with
 * `/.well-known/agent-card.json` after it, so it carries the public origin when one is set.
 */
export async function getAgentCard(
  agent: string,
  options?: { readonly signal?: AbortSignal; readonly fetch?: Fetcher },
): Promise<AgentCardSummary> {
  const send = options?.fetch ?? fetch;
  const response = await send(
    agentCardPath(agent),
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  const card = cardSchema.parse(await response.json());
  const agentUrl = card.supportedInterfaces[0]?.url ?? '';
  return {
    agentUrl,
    cardUrl: `${agentUrl.replace(/\/+$/, '')}/.well-known/agent-card.json`,
    needsKey: Object.keys(card.securitySchemes ?? {}).length > 0,
  };
}
