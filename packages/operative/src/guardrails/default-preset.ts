import {
  createPromptInjectionDetector,
  DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
  withMinimumTripwireConfidence,
} from 'armorer';

import type { GuardrailsOptions } from './types';
import { createOutputPIIValidator } from './validators/output-pii';

/**
 * AB-40 — the enabled-by-default guardrail preset.
 *
 * A prompt-injection input detector (gated at
 * `confidence >= DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD`, see
 * `withMinimumTripwireConfidence`) and an output PII validator, both in
 * `mode: 'tripwire'`: a trip hard-halts the run with
 * `finishReason: 'tripwire'` rather than substituting a blocked or redacted
 * response.
 *
 * Once the session is tainted (COR-2109) the preset escalates: it adds the unwrapped
 * `createPromptInjectionDetector()`, which has no confidence floor, to every input
 * check, under the group's action.
 *
 * One definition, owned here, because two layers apply it (COR-1367): a
 * `createAgent` agent whose `guardrails` option is omitted and that inherits
 * no policy from a host, and Bureau, for its own composed runs and for a
 * catalog agent that does not resolve guardrails itself. A fresh object on
 * every call, so a caller that mutates the returned options cannot change what
 * the next agent receives.
 */
export function createDefaultGuardrailsPreset(): GuardrailsOptions {
  return {
    mode: 'tripwire',
    input: {
      detectors: [
        withMinimumTripwireConfidence(
          createPromptInjectionDetector(),
          DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
        ),
      ],
    },
    output: { validators: [createOutputPIIValidator()] },
    // COR-2109: once the session is tainted, the unwrapped detector has no confidence floor, so a
    // single-pattern finding the gated one lets through now halts the run.
    taint: { escalatedDetectors: [createPromptInjectionDetector()] },
  };
}
