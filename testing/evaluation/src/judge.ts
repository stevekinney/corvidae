/**
 * The model judge. It calls an injected operative `GenerateFunction` exactly
 * once per case and never constructs a provider: the caller owns the
 * provider, configured for `judge.model` and `judge.effort`, and tests drive
 * it with `createScriptedGenerate`.
 *
 * The system message carries what calibrates the judge (the rubric for the
 * model-judge criteria, the reference material, and the calibration
 * examples); the user message carries the one case being scored. Keeping
 * them in separate messages is what keeps calibration examples apart from
 * dataset cases in the prompt, not just in the configuration.
 *
 * Any failure of the judge itself is an {@link EvaluatorInfrastructureError}:
 * a throw is `judge-error`, and a reply that requests tool calls, is not
 * JSON, fails the result schema, or scores a criterion it was not asked
 * about is `judge-malformed-output`.
 *
 * A release gate records each judge call as a {@link RecordedJudgeOutput}:
 * the reply text and the tools it asked for, or the fact that it threw.
 * {@link readRecordedJudgeOutput} reads one back through the same checks a
 * live reply goes through, so a replayed decision never calls a provider.
 */
import type { GenerateFunction, GenerateResponse, RunResultBase } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { CriterionConfiguration, EvaluatorConfiguration } from './configuration';
import type { EvaluationCase } from './datasets';
import { EvaluatorInfrastructureError } from './verdict';

/** The judge's scores, keyed by criterion name, and its feedback for the evaluated system. */
export interface JudgeVerdict {
  readonly scores: ReadonlyMap<string, { readonly score: number; readonly rationale: string }>;
  readonly feedback: string;
}

/** One judge call as a release gate records it. */
export type RecordedJudgeOutput =
  | {
      readonly kind: 'reply';
      readonly content: string;
      /** The names of any tools the reply asked to call. A verdict never asks for one. */
      readonly requestedTools: readonly string[];
    }
  | { readonly kind: 'error' };

export interface JudgePrompt {
  readonly system: string;
  readonly user: string;
}

export const judgeResponseSchema = z.strictObject({
  criteria: z.array(
    z.strictObject({
      name: z.string(),
      score: z.number().min(0).max(1),
      rationale: z.string(),
    }),
  ),
  feedback: z.string(),
});

/** Asks providers that support structured output for exactly {@link judgeResponseSchema}. */
export const JUDGE_RESPONSE_FORMAT: {
  readonly type: 'json_schema';
  readonly name: string;
  readonly schema: Record<string, unknown>;
} = {
  type: 'json_schema',
  name: 'evaluation_judge_verdict',
  schema: z.toJSONSchema(judgeResponseSchema),
};

function isModelJudged(criterion: CriterionConfiguration): boolean {
  return criterion.kind === 'model-judge';
}

function modelJudgedNames(configuration: EvaluatorConfiguration): string[] {
  return configuration.criteria.filter(isModelJudged).map((criterion) => criterion.name);
}

function judgeThrew(judgeName: string, cause?: unknown): EvaluatorInfrastructureError {
  return new EvaluatorInfrastructureError({
    reason: 'judge-error',
    message: `Model judge "${judgeName}" threw`,
    cause,
  });
}

function renderRubric(configuration: EvaluatorConfiguration): string {
  return configuration.criteria
    .filter(isModelJudged)
    .map((criterion) => {
      const gate =
        criterion.hardThreshold === undefined ? '' : `, hard threshold ${criterion.hardThreshold}`;
      return `- ${criterion.name} (weight ${criterion.weight}${gate}): ${criterion.description}`;
    })
    .join('\n');
}

function renderReferenceMaterial(configuration: EvaluatorConfiguration): string {
  const { version, entries } = configuration.referenceMaterial;
  const body = entries
    .map((entry) => `### ${entry.id}: ${entry.title}\n${entry.text}`)
    .join('\n\n');
  return `## Reference material (version ${version})\n\n${body || 'No reference material.'}`;
}

function renderCalibrationExamples(configuration: EvaluatorConfiguration): string {
  const body = configuration.examples
    .map((example) =>
      [
        `### Example ${example.id}`,
        `Input:\n${example.input}`,
        `Response:\n${example.response}`,
        `Expected verdict: ${example.verdict}`,
        `Rationale: ${example.rationale}`,
      ].join('\n'),
    )
    .join('\n\n');
  return [
    '## Calibration examples',
    'These examples calibrate how you read the rubric. They are not the case under evaluation.',
    body || 'No calibration examples.',
  ].join('\n\n');
}

function renderTrajectory(result: RunResultBase): string {
  const calls = result.steps.flatMap((step) => step.toolCalls);
  if (calls.length === 0) return 'No tool calls.';
  return calls
    .map((call, index) => `${index + 1}. ${call.name} ${JSON.stringify(call.arguments)}`)
    .join('\n');
}

export function renderJudgePrompt(input: {
  readonly configuration: EvaluatorConfiguration;
  readonly evaluationCase: EvaluationCase;
  readonly result: RunResultBase;
}): JudgePrompt {
  const { configuration, evaluationCase, result } = input;
  const system = [
    `You are the evaluation judge "${configuration.judge.name}" (prompt version ${configuration.promptVersion}).`,
    'Score the agent run in the next message against each rubric criterion from 0 (not met) to 1 (fully met).',
    `## Rubric\n\n${renderRubric(configuration)}`,
    renderReferenceMaterial(configuration),
    renderCalibrationExamples(configuration),
    [
      '## Response format',
      'Reply with only a JSON object of the form {"criteria":[{"name":"<criterion>","score":<0 to 1>,"rationale":"<why>"}],"feedback":"<advice for the agent>"}, with one entry per rubric criterion.',
      'The feedback is shown to the agent: never quote the expected answer or the reference material in it.',
    ].join('\n'),
  ].join('\n\n');
  const user = [
    `## Case ${evaluationCase.id}`,
    `Input:\n${evaluationCase.input}`,
    `Expected answer:\n${evaluationCase.expected}`,
    `## Agent final response\n\n${result.content}`,
    `## Tool trajectory\n\n${renderTrajectory(result)}`,
  ].join('\n\n');
  return { system, user };
}

function malformed(
  judgeName: string,
  detail: string,
  cause?: unknown,
): EvaluatorInfrastructureError {
  return new EvaluatorInfrastructureError({
    reason: 'judge-malformed-output',
    message: `Model judge "${judgeName}" returned malformed output: ${detail}`,
    cause,
  });
}

function parseJson(content: string, judgeName: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw malformed(judgeName, 'the reply is not JSON', cause);
  }
}

/** Validates one judge reply against the result schema and the criteria the judge was asked to score. */
export function parseJudgeResponse(
  response: GenerateResponse,
  judgeName: string,
  criterionNames: readonly string[],
): JudgeVerdict {
  if (response.toolCalls.length > 0) {
    throw malformed(judgeName, 'the judge requested tool calls; it must reply with a verdict');
  }
  const parsed = judgeResponseSchema.safeParse(parseJson(response.content, judgeName));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw malformed(judgeName, issues.join('; '), parsed.error);
  }
  const scores = new Map<string, { score: number; rationale: string }>();
  for (const entry of parsed.data.criteria) {
    if (!criterionNames.includes(entry.name)) {
      throw malformed(judgeName, `scored "${entry.name}", which is not a model-judge criterion`);
    }
    if (scores.has(entry.name)) {
      throw malformed(judgeName, `scored "${entry.name}" more than once`);
    }
    scores.set(entry.name, { score: entry.score, rationale: entry.rationale });
  }
  return { scores, feedback: parsed.data.feedback };
}

export interface RunModelJudgeOptions {
  readonly generate: GenerateFunction;
  readonly configuration: EvaluatorConfiguration;
  readonly evaluationCase: EvaluationCase;
  readonly result: RunResultBase;
  readonly signal: AbortSignal;
}

export async function runModelJudge(options: RunModelJudgeOptions): Promise<JudgeVerdict> {
  const { generate, configuration, signal } = options;
  const judgeName = configuration.judge.name;
  const prompt = renderJudgePrompt(options);
  const conversation = new Conversation();
  conversation.appendSystemMessage(prompt.system);
  conversation.appendUserMessage(prompt.user);
  let response: GenerateResponse;
  try {
    response = await generate({
      conversation,
      step: 0,
      signal,
      toolbox: createToolbox([]),
      responseFormat: JUDGE_RESPONSE_FORMAT,
    });
  } catch (cause) {
    throw judgeThrew(judgeName, cause);
  }
  return parseJudgeResponse(response, judgeName, modelJudgedNames(configuration));
}

/**
 * Reads a recorded judge call exactly as {@link runModelJudge} reads a live
 * one: a recorded throw is `judge-error`, and a recorded reply goes through
 * {@link parseJudgeResponse}.
 */
export function readRecordedJudgeOutput(
  output: RecordedJudgeOutput,
  configuration: EvaluatorConfiguration,
): JudgeVerdict {
  const judgeName = configuration.judge.name;
  if (output.kind === 'error') throw judgeThrew(judgeName);
  return parseJudgeResponse(
    { content: output.content, toolCalls: output.requestedTools.map((name) => ({ name })) },
    judgeName,
    modelJudgedNames(configuration),
  );
}
