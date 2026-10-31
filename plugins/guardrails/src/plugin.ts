import { definePlugin } from '@lostgradient/interborough-plugin';
import { z } from 'zod';

import { createCodeSafetyValidator } from './validators/code-safety.ts';
import { createGroundingValidator } from './validators/grounding.ts';

/** Whether `source` compiles as a regular expression. */
function isRegularExpression(source: string): boolean {
  try {
    return new RegExp(source) instanceof RegExp;
  } catch {
    return false;
  }
}

/**
 * Two output validators an agent file adds to Operative's default guardrails with
 * `guardrails: [guardrails:code-safety, guardrails:grounding]`. An agent that lists neither still
 * runs the default preset, which stays in Operative.
 */
export default definePlugin({
  name: 'guardrails',
  version: '1.0.0',
  description:
    'Adds two output guardrails an agent can list: code-safety flags dangerous code, and grounding flags claims the conversation does not support.',
  configuration: z.object({
    /** Regular expressions the code-safety validator flags in addition to its built-in patterns. */
    blockedPatterns: z
      .array(z.string().min(1).refine(isRegularExpression, 'Not a valid regular expression.'))
      .default([]),
    /** The share of a reply's claims that must appear in the conversation, from 0 to 1. */
    groundingThreshold: z.number().min(0).max(1).default(0.8),
  }),
  setup({ configuration }) {
    const { blockedPatterns, groundingThreshold } = configuration;
    return {
      guardrails: {
        outputValidators: [
          createCodeSafetyValidator({
            blockedPatterns: blockedPatterns.map((source) => new RegExp(source)),
          }),
          createGroundingValidator({ groundingThreshold }),
        ],
      },
    };
  },
});
