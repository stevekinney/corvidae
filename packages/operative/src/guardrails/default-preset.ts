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
  };
}
