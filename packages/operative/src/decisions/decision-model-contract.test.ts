import { describe } from 'bun:test';
import { z } from 'zod';

import { createScriptedGenerate } from '../test/scripted-generate';
import {
  type DecisionBatchContractCase,
  type DecisionContractCase,
  runDecisionBatchContract,
  runDecisionModelContract,
} from '../testing/decision-model-contract.test-support';
import { decisionBatchScenarios, decisionScenarios } from '../testing/decision-scenarios';
import { llmDecisionModel } from './llm-decision-model';
import type { DecisionModel, DecisionRequest } from './types';

const structuredSchema = z.object({ team: z.string(), urgent: z.boolean() });
const structuredRequest: DecisionRequest = {
  kind: 'structured',
  question: 'Triage this ticket.',
  context: 'Checkout is down.',
  schema: structuredSchema,
};

const jevCases: readonly DecisionContractCase[] = decisionScenarios.map((scenario) => ({
  name: scenario.name,
  request: scenario.request,
  expected: scenario.expected,
}));
const allKindCases: readonly DecisionContractCase[] = [
  ...jevCases.filter((contractCase) =>
    ['boolean-true', 'choice', 'scale'].includes(contractCase.name),
  ),
  { name: 'structured', request: structuredRequest, expected: { team: 'tech', urgent: true } },
];

/** A scripted model that answers each request from a table, as a consumer's test double would. */
function scriptedDecisionModel(answers: ReadonlyMap<string, unknown>): DecisionModel {
  return {
    name: 'scripted',
    kinds: new Set(['boolean', 'choice', 'scale', 'structured']),
    decide: async (request) => {
      if (!answers.has(request.question + request.kind)) throw new Error('unscripted request');
      return {
        value: answers.get(request.question + request.kind),
        provider: 'scripted',
        model: 'scripted-1',
      };
    },
  };
}

function replyFor(contractCase: DecisionContractCase): string {
  switch (contractCase.request.kind) {
    case 'boolean':
      return JSON.stringify({ answer: contractCase.expected });
    case 'choice':
      return JSON.stringify({ key: contractCase.expected });
    case 'scale':
      return JSON.stringify({ level: contractCase.expected });
    case 'structured':
      return JSON.stringify(contractCase.expected);
  }
}

describe('scripted DecisionModel contract', () => {
  runDecisionModelContract(
    () =>
      scriptedDecisionModel(
        new Map(allKindCases.map((c) => [c.request.question + c.request.kind, c.expected])),
      ),
    allKindCases,
  );
});

const batchCases: readonly DecisionBatchContractCase[] = decisionBatchScenarios.map((scenario) => ({
  name: scenario.name,
  batch: { context: scenario.context, questions: scenario.questions },
  expected: scenario.expected,
}));

describe('scripted DecisionModel batch contract, one question at a time', () => {
  runDecisionBatchContract(
    (contractCase) =>
      scriptedDecisionModel(
        new Map(
          [...contractCase.batch.questions].map(([name, question]) => [
            question.question + question.kind,
            contractCase.expected.get(name),
          ]),
        ),
      ),
    batchCases,
  );
});

describe('llmDecisionModel batch contract over a scripted generate', () => {
  runDecisionBatchContract(
    (contractCase) =>
      llmDecisionModel({
        descriptor: { provider: 'anthropic', model: 'claude-haiku-5-5' },
        generate: createScriptedGenerate(
          [...contractCase.batch.questions].map(([name, question]) => ({
            kind: 'respond' as const,
            response: {
              content: replyFor({
                name,
                request: { ...question },
                expected: contractCase.expected.get(name),
              }),
              toolCalls: [],
            },
          })),
        ),
      }),
    batchCases,
  );
});

describe('llmDecisionModel contract over a scripted generate', () => {
  runDecisionModelContract(
    (contractCase) =>
      llmDecisionModel({
        descriptor: { provider: 'anthropic', model: 'claude-haiku-5-5' },
        generate: createScriptedGenerate(
          contractCase === undefined
            ? []
            : [{ kind: 'respond', response: { content: replyFor(contractCase), toolCalls: [] } }],
        ),
      }),
    allKindCases,
  );
});
