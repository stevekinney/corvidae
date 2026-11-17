/**
 * `bureau.validators.list` (COR-2111): every validator a goal may name, with who it comes from, so
 * a client can offer the choice instead of taking a validator's name and version as free text.
 *
 * Each row is one validator at one version: its `name` and `version`, whether it supplies
 * `deterministic` evidence (`null` when it did not declare it), and its `source`, `bureau` for a
 * validator the host passed to the Bureau or `plugin` for one a running plugin contributes, with
 * the source's name and version.
 *
 * Any authenticated caller may read it: a caller that can create a goal needs it to name a
 * validator, and `bureau.goals.create` needs no scope. It returns what the Bureau was configured
 * with and the running plugins contribute, never a goal's state. The catalog is built at startup,
 * so a plugin enabled or disabled takes effect on the next restart.
 *
 * @module validators-operations
 */

import { defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';

import type { Bureau } from '../../bureau-types/facade.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What `bureau.validators.list` reads from the handler's `host`. */
export type BureauValidatorsOperationHost = {
  readonly goals: Pick<Bureau['goals'], 'validators'>;
};

const listInput = z.object({});

const listOutput = z.object({
  validators: z
    .array(
      z.object({
        name: z.string().describe('The name a goal’s `validator` names it by.'),
        version: z.string().describe('The version a goal’s `validator` pins.'),
        determinism: z
          .enum(['deterministic', 'stochastic'])
          .nullable()
          .describe(
            'Whether it supplies deterministic evidence; `null` when it did not declare it. Only `deterministic` satisfies a goal that requires deterministic validation.',
          ),
        source: z
          .object({
            kind: z
              .enum(['bureau', 'plugin'])
              .describe('`bureau` for a validator the host gave the Bureau; `plugin` otherwise.'),
            name: z.string().describe('`bureau`, or the contributing plugin’s name.'),
            version: z.string().describe('Bureau’s version, or the plugin’s.'),
          })
          .describe('Who the validator comes from.'),
      }),
    )
    .describe('Every validator a goal may name, in registration order.'),
});

/** `bureau.validators.list`. */
export const validatorsListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauValidatorsOperationHost
>({
  name: 'bureau.validators.list',
  authorize: authorizeWorkspaceOperation('bureau.validators.list'),
  mcpExposable: false,
  summary: 'List the goal validators',
  description:
    'Lists every validator a goal may name, one row per name and version: its `name` and `version` (what `bureau.goals.create` takes as `validator`), its `determinism` (`deterministic` or `stochastic`, `null` when it did not declare it), and its `source`, the `bureau` kind for a validator the host gave the Bureau or the `plugin` kind for one a running plugin contributes, with that source’s name and version. The host’s come first, then the running plugins’ in load order. The catalog is built at startup, so a plugin enabled or disabled takes effect on the next restart. Read-only; any authenticated caller that can create a goal may read it.',
  destructive: false,
  tags: ['Goals'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: [],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host }) =>
    Promise.resolve({
      validators: host.goals.validators().map(({ source, ...validator }) => ({
        ...validator,
        source: { ...source },
      })),
    }),
});
