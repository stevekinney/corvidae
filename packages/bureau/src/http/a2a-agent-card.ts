/**
 * The public Agent Card of one published Bureau agent (COR-903), projected from the agent
 * catalog and the agent's definition. The kit (`createA2AHandler`) adds the card's one
 * interface (its URL, `protocolVersion: "1.0"`, and `tenant`) and its signatures, and serves it
 * with `ETag` and `Cache-Control`.
 *
 * - `name` is the agent's display name, falling back to its catalog name. The agent's identity
 *   is the catalog name its interface URL ends in plus `version`, its definition revision.
 * - `description` is the agent's, else a sentence naming it.
 * - Input modes are `text/plain` and `application/json` (an approval's decision travels as a
 *   data part) and output is `text/plain`, plus the media types of every modality the agent's
 *   backend descriptors take in or put out (COR-788); see {@link mediaModesOf}.
 * - `skills` are the agent's skill descriptors, or one skill standing for the agent itself.
 * - `capabilities.streaming` is `true`; `pushNotifications` is `true` only where the Bureau composes both an outbox and the durable
 *   event history (COR-1543),
 *   and `extendedAgentCard` is `false`.
 * - The extensions are cleanup, A2UI's, and, where the Bureau keeps durable stores (a persistent
 *   ledger and event history), durable history and command receipts. Every one is
 *   `required: false`.
 *
 * @module a2a-agent-card
 */

import type { AgentCard, AgentExtension, AgentSkill } from '@a2a-js/sdk';
import type { A2AAgentCardInput, A2ASecurityDeclaration } from '@lostgradient/weft/a2a';
import type { AgentSkillDescriptor } from '@lostgradient/operative';

import { CLEANUP_EXTENSION_URI } from './a2a-task-projection.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { DURABLE_HISTORY_EXTENSION_URI } from './a2a-task-stream.ts';

/** The A2UI A2A extension of the pinned A2UI release (`v0.9.1`). */
export const A2UI_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v0.9.1';

/** The media types every Bureau agent reads over A2A: text, and a data part (an approval's decision). */
export const A2A_INPUT_MODES: readonly string[] = ['text/plain', 'application/json'];

/** The media types every Bureau agent answers with over A2A. */
export const A2A_OUTPUT_MODES: readonly string[] = ['text/plain'];

/** The media types a modality stands for on the wire, as `type/*` families or the one exact type. */
const MODALITY_MEDIA_TYPES: Readonly<Record<string, readonly string[]>> = {
  image: ['image/*'],
  audio: ['audio/*'],
  video: ['video/*'],
  document: ['application/pdf'],
  file: ['application/octet-stream'],
};

/**
 * The media types an agent's models take in and put out, from the backend descriptors behind its
 * `generate` (`BackendDescriptor.modalities`): the text modes every agent has, then each
 * modality some descriptor accepts (or produces) as its media types. An agent whose `generate`
 * carries no descriptor is text-only. Generated JSON is a document, so a document or file output
 * also advertises `application/json`.
 */
export function mediaModesOf(
  descriptors: readonly {
    readonly modalities: Readonly<Record<string, { input: boolean; output: boolean }>>;
  }[],
): { readonly input: readonly string[]; readonly output: readonly string[] } {
  const input = new Set(A2A_INPUT_MODES);
  const output = new Set(A2A_OUTPUT_MODES);
  for (const descriptor of descriptors) {
    for (const [modality, support] of Object.entries(descriptor.modalities)) {
      for (const type of MODALITY_MEDIA_TYPES[modality] ?? []) {
        if (support.input) input.add(type);
        if (support.output) output.add(type);
      }
      if (support.output && (modality === 'document' || modality === 'file')) {
        output.add('application/json');
      }
    }
  }
  return { input: [...input], output: [...output] };
}

/** What the card of one agent is built from. */
export type A2AAgentCardSource = {
  /** The agent's catalog name: the last segment of its interface URL. */
  readonly catalogName: string;
  readonly displayName: string | undefined;
  readonly description: string | undefined;
  /** The agent definition's revision, published as `version`. */
  readonly definitionRevision: number;
  readonly skillDescriptors: readonly AgentSkillDescriptor[] | undefined;
  /** The media types the agent reads, from its backend descriptors; text-only when it has none. */
  readonly inputModes?: readonly string[] | undefined;
  /** The media types the agent answers with. */
  readonly outputModes?: readonly string[] | undefined;
  /** The credentials the handler enforces; `undefined` when every request is the local caller. */
  readonly security: A2ASecurityDeclaration | undefined;
  /** Whether the Bureau keeps a durable event history, which the durable-history extension needs. */
  readonly durableHistory: boolean;
  /**
   * Whether the Bureau delivers push notifications: only where both an outbox and the durable
   * event history are composed, because a push notification is a projection of durable history.
   */
  readonly pushNotifications: boolean;
};

const CLEANUP_EXTENSION: AgentExtension = {
  uri: CLEANUP_EXTENSION_URI,
  description: 'Reports whether a canceled task’s cleanup finished, beside its terminal state.',
  required: false,
  params: {},
};

const DURABLE_HISTORY_EXTENSION: AgentExtension = {
  uri: DURABLE_HISTORY_EXTENSION_URI,
  description:
    'Resumes SubscribeToTask from a durable cursor: the current Task first, then only later events.',
  required: false,
  params: {},
};

const COMMAND_RECEIPTS_EXTENSION: AgentExtension = {
  uri: COMMAND_RECEIPTS_EXTENSION_URI,
  description:
    'Reports each send’s receipt and the task’s revision, takes expectedRevision and a deadline, and types a reused messageId.',
  required: false,
  params: {},
};

const A2UI_EXTENSION: AgentExtension = {
  uri: A2UI_EXTENSION_URI,
  description: 'Carries A2UI surfaces to a client that renders them.',
  required: false,
  params: {},
};

/** The URIs of the extensions a card declares: the ones a request may activate. */
export function declaredExtensionsOf(card: Pick<AgentCard, 'capabilities'>): ReadonlySet<string> {
  return new Set((card.capabilities?.extensions ?? []).map((extension) => extension.uri));
}

function skillOf(descriptor: AgentSkillDescriptor): AgentSkill {
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    tags: [...descriptor.tags],
    examples: [...(descriptor.examples ?? [])],
    inputModes: [...(descriptor.inputModes ?? [])],
    outputModes: [...(descriptor.outputModes ?? [])],
    securityRequirements: [],
  };
}

/** The card of one published agent, without the interface and signatures the kit adds. */
export function createBureauAgentCard(source: A2AAgentCardSource): A2AAgentCardInput {
  const name =
    source.displayName === undefined || source.displayName === ''
      ? source.catalogName
      : source.displayName;
  const description =
    source.description === undefined || source.description === ''
      ? `The ${name} agent.`
      : source.description;
  const skills =
    source.skillDescriptors !== undefined && source.skillDescriptors.length > 0
      ? source.skillDescriptors.map(skillOf)
      : [
          {
            id: source.catalogName,
            name,
            description,
            tags: [],
            examples: [],
            inputModes: [],
            outputModes: [],
            securityRequirements: [],
          },
        ];
  const card: Omit<AgentCard, 'supportedInterfaces' | 'signatures'> = {
    name,
    description,
    provider: undefined,
    version: String(source.definitionRevision),
    documentationUrl: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: source.pushNotifications,
      extendedAgentCard: false,
      extensions: [
        CLEANUP_EXTENSION,
        ...(source.durableHistory ? [DURABLE_HISTORY_EXTENSION] : []),
        COMMAND_RECEIPTS_EXTENSION,
        A2UI_EXTENSION,
      ].map((extension) => ({ ...extension, params: {} })),
    },
    securitySchemes: { ...source.security?.securitySchemes },
    securityRequirements: [...(source.security?.securityRequirements ?? [])],
    defaultInputModes: [...(source.inputModes ?? A2A_INPUT_MODES)],
    defaultOutputModes: [...(source.outputModes ?? A2A_OUTPUT_MODES)],
    skills,
    iconUrl: undefined,
  };
  return card;
}
