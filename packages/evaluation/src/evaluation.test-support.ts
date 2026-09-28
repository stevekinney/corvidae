import type {
  FinishReason,
  JSONValue,
  RunResultBase,
  StepResult,
  ToolCall,
} from '@lostgradient/operative';
import { Conversation } from 'conversationalist';

/**
 * Shared fixtures for this workspace's tests. Every builder returns a fresh
 * object, so a test that mutates or deletes a field never leaks into another.
 */

export const EXPECTED_ANSWER = 'Paris, on the Seine';
export const STYLE_GUIDE_TEXT = 'Answer with the city name first, then one supporting landmark.';
export const CALIBRATION_RESPONSE = 'Lyon is the capital, next to the Rhone.';

/** A complete model-judged configuration exercising every criterion kind. */
export function modelConfigurationInput(): Record<string, unknown> {
  return {
    name: 'capital-cities',
    revision: 3,
    passThreshold: 0.75,
    criteria: [
      {
        name: 'names-the-capital',
        kind: 'deterministic-assertion',
        description: 'The final answer names the expected capital.',
        weight: 3,
        hardThreshold: 1,
      },
      {
        name: 'concise',
        kind: 'heuristic',
        description: 'The answer stays under forty words.',
        weight: 1,
      },
      {
        name: 'no-web-search',
        kind: 'trajectory',
        description: 'The agent answers from memory without searching the web.',
        weight: 1,
        hardThreshold: 1,
        forbiddenTools: ['web_search'],
        requiredTools: [],
      },
      {
        name: 'follows-style-guide',
        kind: 'policy',
        description: 'The answer follows the style guide.',
        weight: 1,
        referenceMaterialId: 'style-guide',
      },
      {
        name: 'helpful-tone',
        kind: 'model-judge',
        description: 'The answer is courteous and directly addresses the question.',
        weight: 2,
      },
    ],
    examples: [
      {
        id: 'calibration-lyon',
        input: 'What is the capital of France?',
        response: CALIBRATION_RESPONSE,
        verdict: 'fail',
        rationale: 'Names the wrong city.',
      },
    ],
    referenceMaterial: {
      version: 'style-guide-2026-09',
      entries: [{ id: 'style-guide', title: 'Answer style guide', text: STYLE_GUIDE_TEXT }],
    },
    judge: {
      kind: 'model',
      name: 'rubric-judge',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      tools: [],
    },
    promptVersion: 'judge-prompt-3',
    datasetVersion: 'capitals-2026-09',
    environment: { name: 'fixture-harness', revision: 'harness-7' },
    budgets: {
      perEvaluation: { costUsd: 0.05, latencyMilliseconds: 30_000 },
      perGateRun: { costUsd: 5, latencyMilliseconds: 600_000 },
    },
    repetitions: 3,
    resultSchemaVersion: 1,
    codeRevision: 'a7679370f3e1a3b850299d13c9e768541a601722',
  };
}

/** A configuration with a deterministic judge and no model-judge criterion. */
export function deterministicConfigurationInput(): Record<string, unknown> {
  const input = modelConfigurationInput();
  input['criteria'] = (input['criteria'] as { kind: string }[]).filter(
    (criterion) => criterion.kind !== 'model-judge',
  );
  input['judge'] = { kind: 'deterministic', name: 'fixture-checks' };
  input['repetitions'] = 1;
  return input;
}

export function datasetInput(): {
  version: string;
  cases: { id: string; input: string; expected: string }[];
} {
  return {
    version: 'capitals-2026-09',
    cases: [
      { id: 'case-france', input: 'What is the capital of France?', expected: EXPECTED_ANSWER },
      { id: 'case-japan', input: 'What is the capital of Japan?', expected: 'Tokyo' },
    ],
  };
}

export interface RunResultFixture {
  readonly content?: string;
  readonly finishReason?: FinishReason;
  readonly toolCalls?: readonly { readonly name: string; readonly arguments?: JSONValue }[];
  readonly error?: unknown;
}

/**
 * A completed operative `RunResultBase`. Each requested tool call becomes its
 * own non-final step with a successful result, followed by one final step
 * carrying `content`.
 */
export function runResult(fixture: RunResultFixture = {}): RunResultBase {
  const conversation = new Conversation();
  const content = fixture.content ?? 'Paris, on the Seine.';
  const toolSteps = (fixture.toolCalls ?? []).map((call, index): StepResult => {
    const toolCall: ToolCall = {
      id: `call-${index}`,
      name: call.name,
      arguments: call.arguments ?? {},
    };
    return {
      step: index,
      conversation,
      content: '',
      toolCalls: [toolCall],
      results: [
        {
          callId: toolCall.id,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          outcome: 'success',
          content: 'ok',
          result: 'ok',
        },
      ],
      final: false,
    };
  });
  const finalStep: StepResult = {
    step: toolSteps.length,
    conversation,
    content,
    toolCalls: [],
    results: [],
    final: true,
  };
  return {
    conversation,
    steps: [...toolSteps, finalStep],
    content,
    usage: { prompt: 12, completion: 8, total: 20 },
    finishReason: fixture.finishReason ?? 'stop-condition',
    ...(fixture.error === undefined ? {} : { error: fixture.error }),
  };
}

/** A judge reply scoring the model-judge criteria of {@link modelConfigurationInput}. */
export function judgeReply(overrides: { score?: number; feedback?: string } = {}): string {
  return JSON.stringify({
    criteria: [
      {
        name: 'helpful-tone',
        score: overrides.score ?? 1,
        rationale: 'Courteous and direct.',
      },
    ],
    feedback: overrides.feedback ?? 'Clear, direct answer.',
  });
}
