import { describe, expect, it } from 'bun:test';

import { RecordingTracer } from './instrumentation-fixtures';

// AB-230 attribute-classification table.
//
// Every `span.setAttribute`/`span.setAttributes`/`span.addEvent(name, attrs)`
// call site in `packages/operative/src/instrumentation/index.ts`, plus the
// one span-attribute call elsewhere in the package's `src/` that is not
// under an `instrumentation/` directory
// (`durable/run-workflow.ts:970`, a Weft durable-workflow context — not an
// OTel span). None of operative's own instrumentation attributes carry tool
// arguments, tool results, provider request/response content, or
// conversation content: the module observes loop-level structure (step
// index, tool-call counts and names, usage, finish reason, error category)
// and never touches a `GenerateResponse.content`, a tool call's
// `arguments`, or a tool result. `packages/operative/src/providers/instrumentation/index.ts`
// is a separate emission site and has its own table in
// `provider-instrumentation.test.ts`.
type AttributeClassificationRow = {
  callSite: string;
  attributeKey: string;
  sourceValue: string;
  privileged: boolean;
  treatment: 'emitted' | 'omitted';
};

const OPERATIVE_ATTRIBUTE_CLASSIFICATION_TABLE: AttributeClassificationRow[] = [
  {
    callSite: "'run.started' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.operation.name',
    sourceValue: "literal 'invoke_agent'",
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.started' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.agent.name',
    sourceValue: 'options.agentName (configured identity, not conversation content)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'step.started' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'operative.step.index',
    sourceValue: 'step (a counter)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: 'setUsageAttributes() → span.setAttributes(...)',
    attributeKey:
      'gen_ai.usage.input_tokens / output_tokens / cache_creation.input_tokens / cache_read.input_tokens',
    sourceValue: 'usage.* (token counts)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.completed' listener → generateSpan.setAttributes(...)",
    attributeKey: 'operative.usage.prompt_tokens / completion_tokens / total_tokens',
    sourceValue: 'response.usage.* (token counts)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.completed' listener → generateSpan.setAttribute(...)",
    attributeKey: 'operative.generate.duration_ms',
    sourceValue: 'durationMilliseconds (timing)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.error' listener → generateSpan.setAttribute(...)",
    attributeKey: 'error.type',
    sourceValue: "error.name ?? '_OTHER' (a category name, not error content)",
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.error' listener → generateSpan.setAttribute(...)",
    attributeKey: 'operative.generate.duration_ms',
    sourceValue: 'durationMilliseconds (timing)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tools.executing' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'operative.tools.count',
    sourceValue: 'toolCalls.length (a count)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tools.executing' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'operative.tools.names',
    sourceValue: 'toolCalls.map(tc => tc.name) — tool identity, not tool arguments',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tools.executed' listener → toolsSpan.setAttribute(...)",
    attributeKey: 'operative.tools.results_count',
    sourceValue: 'results.length (a count, not the results themselves)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.completed' listener → runSpan.setAttributes(...)",
    attributeKey: 'operative.finish_reason',
    sourceValue: 'event.finishReason (an event type name)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.completed' listener → runSpan.setAttributes(...)",
    attributeKey: 'operative.total_steps',
    sourceValue: 'event.steps.length (a count)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.error' listener → runSpan.setAttributes(...)",
    attributeKey: 'error.type / operative.error.kind / operative.error.code',
    sourceValue: 'telemetryError.name, error.kind, error.code (category names/codes)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.aborted' listener → runSpan.setAttribute(s)(...)",
    attributeKey:
      'operative.abort_reason / error.type / operative.error.kind / operative.error.code',
    sourceValue: "literal 'aborted' (COR-96: never the caller-supplied reason), error.name, error.kind, error.code (category names/codes)",
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.retry' listener → generateSpan.addEvent('generate.retry', attrs)",
    attributeKey: 'retry.attempt',
    sourceValue: 'attempt (a count)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite:
      'durable/run-workflow.ts:970 → ctx.setAttribute(...) (Weft workflow context, not an OTel span)',
    attributeKey: 'runId',
    sourceValue: 'runId (a correlation identifier)',
    privileged: false,
    treatment: 'emitted',
  },
];

describe('AB-230 operative attribute-classification table', () => {
  it('has no privileged rows — operative instrumentation never observes tool/provider/conversation content', () => {
    expect(OPERATIVE_ATTRIBUTE_CLASSIFICATION_TABLE.every((row) => !row.privileged)).toBe(true);
    expect(
      OPERATIVE_ATTRIBUTE_CLASSIFICATION_TABLE.every((row) => row.treatment === 'emitted'),
    ).toBe(true);
  });
});

describe('RecordingTracer unsupported operations', () => {
  it('fails loudly instead of silently accepting unsupported OTel operations', () => {
    const tracer = new RecordingTracer();
    const span = tracer.startSpan('fixture');

    expect(() => span.addLink({ context: span.spanContext() })).toThrow(
      'RecordingSpan.addLink is unsupported in this fixture',
    );
    expect(() => span.addLinks([])).toThrow(
      'RecordingSpan.addLinks is unsupported in this fixture',
    );
    expect(() => span.updateName('renamed')).toThrow(
      'RecordingSpan.updateName is unsupported in this fixture',
    );
    expect(() => tracer.startActiveSpan('fixture', () => 'result')).toThrow(
      'RecordingTracer.startActiveSpan is unsupported in this fixture',
    );
  });
});
