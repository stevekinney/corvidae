/**
 * `bureau.validators.list` (COR-2111): every validator a goal may name, with who it comes from, so
 * a client can offer the choice instead of taking a validator's name and version as free text.
 *
 * Each row is one validator at one version: its `name` and `version`, whether it supplies
 * `deterministic` evidence (`null` when it did not declare it), its `configuration` as JSON Schema
 * (`null` when it takes none, COR-2117), and its `source`, `bureau` for a
 * validator the host passed to the Bureau, `plugin` for one a running plugin contributes, or
 * `bungalow` for one the owner wrote as a file (COR-2119), with the source's name and version (a
 * file's version is the digest of what it says).
 *
 * Any authenticated caller may read it: a caller that can create a goal needs it to name a
 * validator, and `bureau.goals.create` needs no scope. It returns what the Bureau was configured
 * with and the running plugins contribute, never a goal's state. The catalog of the host's and the
 * plugins' validators is built at startup, so a plugin enabled or disabled takes effect on the next
 * restart; the owner's validator files are read as they change.
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
        configuration: z
          .record(z.string(), z.unknown())
          .nullable()
          .describe(
            'The JSON Schema of the configuration a goal may give it, which the Bureau parses before it stores it; `null` when the validator takes none.',
          ),
        source: z
          .object({
            kind: z
              .enum(['bureau', 'plugin', 'bungalow'])
              .describe(
                '`bureau` for a validator the host gave the Bureau, `plugin` for one a plugin contributes, `bungalow` for one the owner wrote as a file.',
              ),
            name: z.string().describe('`bureau`, the contributing plugin’s name, or `bungalow`.'),
            version: z
              .string()
              .describe(
                'Bureau’s version, the plugin’s, or the file’s version, which is a digest of what it says.',
              ),
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
    'Lists every validator a goal may name, one row per name and version: its `name` and `version` (what `bureau.goals.create` takes as `validator`), its `determinism` (`deterministic` or `stochastic`, `null` when it did not declare it), its `configuration` (the JSON Schema of what a goal may configure it with, passed as `validator.configuration` to `bureau.goals.create`, or `null` when it takes none), and its `source`, the `bureau` kind for a validator the host gave the Bureau the `plugin` kind for one a running plugin contributes, or the `bungalow` kind for one the owner wrote as a file in the Bungalow’s `validators` folder (its `version` is a digest of what the file says), with that source’s name and version. The host’s come first, then the running plugins’ in load order, then the owner’s files by name. The host’s and the plugins’ are built at startup, so a plugin enabled or disabled takes effect on the next restart; the owner’s files are read as they change. Read-only; any authenticated caller that can create a goal may read it.',
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
