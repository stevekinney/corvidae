/**
 * The tools an agent reads and changes the deployment's settings with (COR-1710): `settings-get`
 * and `settings-update`. Bureau adds them to the tool catalog itself, whenever the Bureau exists,
 * so an agent file receives them only when it lists them in `tools`; listing them is the grant, as
 * it is for the `workflows-*` tools. They call `Bureau.settings`, the same operations HTTP callers
 * use, and act as the calling task's principal, read through `ownerOf` and never from the request:
 * the `settings.changed` audit record names that principal.
 *
 * Every outcome is an ordinary tool result, never a thrown error, so a refusal reaches the model
 * as something it can read and correct.
 *
 * @module settings-tools
 */

import { createTool, type Tool } from 'armorer';
import { z } from 'zod';

import { runIdOf } from '../workflow-tools.ts';
import type { BureauSettings, SettingsSnapshot, SettingsUpdateResult } from './types.ts';

/** The names of the two tools. Hyphens, because provider tool-name grammars exclude dots. */
export const SETTINGS_TOOL_NAMES = ['settings-get', 'settings-update'] as const;

/** The name of a tool in the agent source's `tools` that one of the two would collide with, if there is one. */
export function collidingSettingsToolName(
  tools: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return SETTINGS_TOOL_NAMES.find((name) => tools !== undefined && Object.hasOwn(tools, name));
}

/** What the tools read from the Bureau that owns them. */
export interface SettingsToolHost {
  /** The settings. Read on every call, because the tools exist before the settings do. */
  readonly settings: () => BureauSettings;
  /** The owner of record of a run, for the run that made a tool call. */
  readonly ownerOf: (runId: string) => Promise<string | undefined>;
}

/** The tools, bound to the Bureau they read from. */
export function createSettingsTools(host: SettingsToolHost): Record<string, Tool> {
  const get = createTool({
    name: 'settings-get',
    version: '1.0.0',
    description:
      "Read the deployment's runtime settings: each setting's value by dotted key, the `revision` to pass to settings-update as `expectedRevision`, and per key whether it applies live or at restart and whether it is locked (with the `lockReason`).",
    input: z.object({}),
    metadata: { readOnly: true, shortDescription: "Read the deployment's runtime settings." },
    execute: async (): Promise<SettingsSnapshot> => host.settings().get(),
  });

  const update = createTool({
    name: 'settings-update',
    version: '1.0.0',
    description:
      "Change the deployment's runtime settings. `patch` maps dotted keys (as settings-get names them) to new values; all of them change or none do. `expectedRevision` is the revision settings-get returned: if the settings changed since, the answer is `rejected` with reason `stale-revision` and the `currentRevision` to read again. A locked key, an unknown key, or an invalid value is also `rejected`, with the keys at fault.",
    input: z.object({
      patch: z.record(z.string(), z.unknown()).describe('The settings to change, by dotted key.'),
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .describe('The revision settings-get returned.'),
    }),
    metadata: { mutates: true, shortDescription: "Change the deployment's runtime settings." },
    execute: async (input, context): Promise<SettingsUpdateResult> => {
      const runId = runIdOf(context);
      const principal = runId === undefined ? undefined : await host.ownerOf(runId);
      return host.settings().update(input.patch, {
        expectedRevision: input.expectedRevision,
        ...(principal === undefined ? {} : { principal }),
      });
    },
  });

  return { 'settings-get': get, 'settings-update': update };
}
