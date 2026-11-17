/**
 * `bureau.guardrails.list` (COR-2118): every guardrail installed in the Bureau, as a client needs it
 * to let a person choose and configure an agent's guardrails.
 *
 * Each row is one guardrail of one family: the `id` (`plugin:name`) an agent file's `guardrails`
 * lists, its `family`, its `description`, whether it is `configurable` (a factory, which a file
 * configures as `{ id, configuration }`) and its `configuration` as JSON Schema, with the plugin-wide
 * defaults a field the agent leaves out takes, and its `source`: a running plugin, or the host.
 *
 * It is read-only and any authenticated caller may read it, as `bureau.plugins.contributions` is:
 * it returns what plugins and the host declare, never state.
 *
 * @module guardrails-operations
 */

import { defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';

import type { BureauPlugins } from '../../plugins/plugin-types.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What `bureau.guardrails.list` reads from the handler's `host`. */
export type BureauGuardrailsOperationHost = {
  readonly plugins: Pick<BureauPlugins, 'guardrails'>;
};

const listInput = z.object({});

const listOutput = z.object({
  guardrails: z
    .array(
      z.object({
        id: z
          .string()
          .describe('`plugin:name`, the id an agent file’s `guardrails` lists the guardrail by.'),
        family: z
          .enum(['input', 'output', 'tools', 'memory'])
          .describe(
            'What it guards: the input and tool results, a reply, tool calls, or governed memory. A `memory` guardrail guards the host’s memory and no agent file chooses it.',
          ),
        description: z.string().describe('What the guardrail guards, in a sentence.'),
        configurable: z
          .boolean()
          .describe(
            'Whether an agent file can configure it, as `{ id, configuration }`. One that is not takes only its id.',
          ),
        configuration: z
          .record(z.string(), z.unknown())
          .nullable()
          .describe(
            'The fields its configuration takes, as JSON Schema, with the default a field the agent leaves out takes; `null` when it takes none, or when the schema cannot be written as one.',
          ),
        source: z
          .enum(['plugin', 'host', 'bungalow'])
          .describe(
            'Who installed it: a running plugin, the host that built the Bureau, or the owner, as a file in the Bungalow’s `guardrails` folder.',
          ),
        plugin: z
          .string()
          .nullable()
          .describe(
            'The contributing plugin’s name, the first half of `id`; `null` for an owner’s guardrail, whose `id` is its file’s name and which no plugin holds.',
          ),
      }),
    )
    .describe(
      'Every installed guardrail, one row per family it serves: the host’s first, then the running plugins’ in load order, then the owner’s files by name.',
    ),
});

/** `bureau.guardrails.list`. */
export const guardrailsListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauGuardrailsOperationHost
>({
  name: 'bureau.guardrails.list',
  authorize: authorizeWorkspaceOperation('bureau.guardrails.list'),
  mcpExposable: false,
  summary: 'List the installed guardrails',
  description:
    'Lists every guardrail installed in the Bureau, one row per family it serves (`input`, `output`, `tools`, or `memory`, which guards the host’s memory and no agent file chooses): the `id` (`plugin:name`) an agent file’s `guardrails` lists, its `description`, whether it is `configurable` and its `configuration` as JSON Schema (a configurable guardrail is listed in a file as `{ id, configuration }`, and a field the configuration leaves out takes the default the schema shows), and its `source`, a running `plugin`, the `host`, or the `bungalow` for a guardrail the owner wrote as a file in the Bungalow’s `guardrails` folder, with the `plugin` that contributes it (`null` for an owner’s guardrail, whose `id` is its file’s name, not `plugin:name`). The host’s come first, then the running plugins’ in load order, then the owner’s files by name. Read-only; any authenticated caller may read it.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: [],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host }) =>
    Promise.resolve({
      guardrails: host.plugins.guardrails().map((guardrail) => ({ ...guardrail })),
    }),
});
