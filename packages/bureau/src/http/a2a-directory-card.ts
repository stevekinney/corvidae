/**
 * The directory of the agents a deployment shares over A2A (COR-2019), served at
 * `<publicUrl>/a2a/.well-known/agent-card.json`: the one address a person gives a caller so it can
 * find out which agents are on offer. An A2A Agent Card describes one agent, so each agent keeps
 * its own at its own address; this document is the card of the deployment, with one interface and
 * one skill per shared agent, and an `agents` list that names each agent's own card.
 *
 * It says nothing the agents' own public cards do not: it lists exactly the agents that opted in,
 * by name, display name and description, and is served without credentials as they are.
 *
 * @module a2a-directory-card
 */

import type { A2AAgentCardSource } from './a2a-agent-card.ts';
import { A2A_INPUT_MODES, A2A_OUTPUT_MODES } from './a2a-agent-card.ts';

/** The path of the directory under the mount, which no agent's name can take. */
export const A2A_DIRECTORY_PATH = '/a2a/.well-known/agent-card.json';

/** One shared agent in the directory. */
export type A2ADirectoryAgent = Pick<
  A2AAgentCardSource,
  'catalogName' | 'displayName' | 'description'
>;

/** What the directory is built from. */
export type A2ADirectorySource = {
  /** The origin and base path the mount is served under, without a trailing slash. */
  readonly publicUrl: string;
  /** The deployment's identifier, which every interface names as its tenant. */
  readonly tenant: string;
  /** Whether the agents' own cards declare push notifications. */
  readonly pushNotifications: boolean;
  /** The agents that opted in, in the order the deployment lists them. */
  readonly agents: readonly A2ADirectoryAgent[];
};

/** The address of an agent's A2A interface under `publicUrl`. */
export function a2aInterfaceUrl(publicUrl: string, agentName: string): string {
  return `${publicUrl}/a2a/${encodeURIComponent(agentName)}`;
}

/** The directory document: a card for the deployment, plus the `agents` it offers. */
export function createA2ADirectoryCard(source: A2ADirectorySource): Record<string, unknown> {
  const entries = source.agents.map((agent) => {
    const name =
      agent.displayName === undefined || agent.displayName === ''
        ? agent.catalogName
        : agent.displayName;
    const description =
      agent.description === undefined || agent.description === ''
        ? `The ${name} agent.`
        : agent.description;
    const url = a2aInterfaceUrl(source.publicUrl, agent.catalogName);
    return { catalogName: agent.catalogName, name, description, url };
  });
  return {
    name: 'Shared agents',
    description:
      'The agents this deployment answers for over A2A. Each has its own Agent Card at the address its entry names.',
    version: '1',
    supportedInterfaces: entries.map((entry) => ({
      url: entry.url,
      protocolBinding: 'JSONRPC',
      tenant: source.tenant,
      protocolVersion: '1.0',
    })),
    capabilities: {
      streaming: true,
      pushNotifications: source.pushNotifications,
      extendedAgentCard: false,
    },
    defaultInputModes: [...A2A_INPUT_MODES],
    defaultOutputModes: [...A2A_OUTPUT_MODES],
    skills: entries.map((entry) => ({
      id: entry.catalogName,
      name: entry.name,
      description: entry.description,
      tags: [],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    agents: entries.map((entry) => ({
      name: entry.catalogName,
      displayName: entry.name,
      description: entry.description,
      url: entry.url,
      cardUrl: `${entry.url}/.well-known/agent-card.json`,
    })),
  };
}
