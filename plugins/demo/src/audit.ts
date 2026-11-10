/**
 * The demo plugin's `audit` interceptor set: the repository's worked example of a plugin that
 * contributes run hooks. It applies to every agent (the demo's agents are code agents, which no
 * agent file selects) and has one `onStep` hook that writes what each step spent and which tool
 * calls it made to the plugin's own storage.
 *
 * @module audit
 */

import type { PluginInterceptor } from '@lostgradient/interborough-plugin';
import { textValueStore, type Storage } from '@lostgradient/storage';

/** The name of the interceptor set, as an agent file would list it: `demo:audit`. */
export const AUDIT_INTERCEPTOR_NAME = 'audit';

/**
 * The key one step's entry is written under in the plugin's scoped storage (the backing store holds
 * it as `plugin:demo:run:<runId>:step:<n>`). It is a function of the run and the step alone, so a
 * step a recovered durable run replays writes the same key again and overwrites its entry.
 */
export function auditStepKey(runId: string, step: number): string {
  return `run:${runId}:step:${step}`;
}

/** What an audit entry records about one step, stored as JSON under {@link auditStepKey}. */
export interface AuditStepEntry {
  /** The step's index within its run. */
  readonly step: number;
  /** The tokens the step spent, or `null` when the model reported none. */
  readonly usage: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  } | null;
  /** The ids of the tool calls the step made, in order. */
  readonly toolCallIds: readonly string[];
}

/**
 * The `audit` set over `storage`. Its `onStep` is declared `replay: 'effectful'`, because it writes
 * outside the run: a durable run that recovers a step runs it again, and the deterministic key
 * means the second write replaces the first rather than adding an entry. A step that carries no
 * `runId` (a run the host started with none) has no key to write under, so the hook records nothing
 * for it rather than inventing one.
 */
export function createAuditInterceptor(storage: Storage): PluginInterceptor {
  // `disposeUnderlyingStorage: false` because the plugin's storage outlives the hook: nothing here closes it.
  const entries = textValueStore(storage, { disposeUnderlyingStorage: false });
  return {
    name: AUDIT_INTERCEPTOR_NAME,
    appliesTo: 'every-agent',
    onStep: {
      replay: 'effectful',
      handler: async (result) => {
        if (result.runId === undefined) return;
        const entry: AuditStepEntry = {
          step: result.step,
          usage: result.usage
            ? {
                prompt: result.usage.prompt,
                completion: result.usage.completion,
                total: result.usage.total,
              }
            : null,
          toolCallIds: result.toolCalls.map((call) => call.id),
        };
        await entries.set(auditStepKey(result.runId, result.step), JSON.stringify(entry));
      },
    },
  };
}
