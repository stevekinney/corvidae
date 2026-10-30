/**
 * The guardrail presets an agent file names (`guardrails: default | tripwire | off`).
 *
 * Operative owns the detectors: one preset, {@link createDefaultGuardrailsPreset}, a
 * prompt-injection input detector and an output PII validator, which an agent runs when it names
 * nothing. A file picks how those detectors act on a hit, and Bureau maps the name to the
 * `GuardrailsOptions` that `createAgent` takes.
 *
 * @module guardrail-presets
 */

import { createDefaultGuardrailsPreset, type GuardrailsOptions } from '@lostgradient/operative';

import type { AgentGuardrailPreset } from './agent-file';

/**
 * The `guardrails` option `createAgent` takes for a preset a file names.
 *
 * - `default`: the shipped detectors in `validate` mode. A flagged input is blocked, so the model
 *   is never called and the agent answers with a refusal; a flagged reply is redacted, so the run
 *   goes on with the PII replaced by placeholders. Both are `run.guardrail` events on the run.
 * - `tripwire`: the shipped detectors exactly as {@link createDefaultGuardrailsPreset} returns
 *   them, in `tripwire` mode. A hit throws, the run ends with the finish reason `tripwire`, and no
 *   reply is delivered. It is also what an agent runs when its file names no preset. It is a
 *   `run.tripwire` event on the run.
 * - `off`: `false`, no guardrails at all.
 *
 * A fresh object on every call, so the detectors one agent's run holds are never another's.
 */
export function guardrailsOfPreset(preset: AgentGuardrailPreset): GuardrailsOptions | false {
  switch (preset) {
    case 'off':
      return false;
    case 'tripwire':
      return createDefaultGuardrailsPreset();
    case 'default': {
      const shipped = createDefaultGuardrailsPreset();
      return {
        ...shipped,
        mode: 'validate',
        ...(shipped.input === undefined ? {} : { input: { ...shipped.input, action: 'block' } }),
        ...(shipped.output === undefined
          ? {}
          : { output: { ...shipped.output, action: 'redact' } }),
      };
    }
  }
}
