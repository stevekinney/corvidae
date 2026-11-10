// Built-in detectors and the detector pipeline live in `armorer`, shared with
// the retrieval surfaces (memory recall, ingested documents, skill
// resources). Re-exported here so existing `operative` consumers keep the
// same import path.
export {
  DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
  createInputLengthDetector,
  createPromptInjectionDetector,
  createTopicBoundaryDetector,
  withMinimumTripwireConfidence,
} from 'armorer';
export type {
  InputLengthDetectorOptions,
  PromptInjectionDetectorOptions,
  TopicBoundaryDetectorOptions,
} from 'armorer';
export { DEFAULT_TAINT_THRESHOLD, createGuardrails } from './create-guardrails';
export { createDefaultGuardrailsPreset } from './default-preset';
export { guardrailActionOf, guardrailOf } from './guardrail-entries';
export { createInputGuardrail } from './input-guardrail';
export { createOutputGuardrail } from './output-guardrail';
export { createSessionTaintTracker } from './session-taint';
export { createToolCallGuardrail } from './tool-call-guardrail';
export { GUARDRAIL_BLOCKED_CODE, createToolResultGuardrail } from './tool-result-guardrail';
export type { ToolResultGuardrailOptions } from './tool-result-guardrail';
export type {
  AssetSafetyPolicy,
  DetectionResult,
  DetectorContext,
  GuardrailEntry,
  GuardrailHooks,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  GuardrailWithAction,
  GuardrailsOptions,
  InputDetector,
  InputGuardrailAction,
  InputGuardrailEntry,
  InputGuardrailGroupOptions,
  InputGuardrailOptions,
  OutputGuardrailAction,
  OutputGuardrailEntry,
  OutputGuardrailGroupOptions,
  OutputGuardrailOptions,
  OutputGuardrailTriggeredEvent,
  OutputValidator,
  SessionTaintOptions,
  SessionTaintTracker,
  SessionTaintedEvent,
  ToolCallGuardrailAction,
  ToolCallGuardrailOptions,
  ToolCallGuardrailTriggeredEvent,
  ToolCallValidationResult,
  ToolCallValidator,
  ToolCallValidatorCall,
  ToolCallValidatorContext,
  ValidationResult,
  ValidatorContext,
} from './types';
export { createOutputPIIValidator } from './validators/output-pii';
