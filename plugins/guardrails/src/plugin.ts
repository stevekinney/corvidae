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

/** A regular expression a code-safety configuration names, checked to compile. */
const patternSchema = z
  .string()
  .min(1)
  .refine(isRegularExpression, 'Not a valid regular expression.');

/** The share of a reply's claims that must appear in the conversation, from 0 to 1. */
const thresholdSchema = z.number().min(0).max(1);

/**
 * Two output guardrails an agent file adds to Operative's default guardrails with
 * `guardrails: [guardrails:code-safety, guardrails:grounding]`. An agent that lists neither still
 * runs the default preset, which stays in Operative.
 *
 * Each is a factory an agent configures (COR-2118), as `{ id: guardrails:grounding, configuration:
 * { threshold: 0.95 } }` or `{ id: guardrails:code-safety, configuration: { blockedPatterns: [...] } }`.
 * The plugin's own `groundingThreshold` and `blockedPatterns` are the defaults: a field an agent
 * leaves out takes them, and one it sets replaces them.
 */
export default definePlugin({
  name: 'guardrails',
  title: 'Guardrails',
  version: '1.2.0',
  description:
    'Adds two output guardrails an agent can list and configure: code-safety flags dangerous code, and grounding flags claims the conversation does not support.',
  configuration: z.object({
    /**
     * Regular expressions the code-safety validator flags in addition to its built-in patterns,
     * for an agent whose own configuration names none.
     */
    blockedPatterns: z.array(patternSchema).default([]),
    /** The grounding threshold of an agent whose own configuration sets none, from 0 to 1. */
    groundingThreshold: thresholdSchema.default(0.8),
  }),
  setup({ configuration }) {
    const { blockedPatterns, groundingThreshold } = configuration;
    return {
      guardrails: {
        output: [
          {
            name: 'code-safety',
            description:
              'Flags dangerous code in a reply: destructive shell commands, code execution, dangerous SQL and pipe-to-shell, and any pattern the configuration adds.',
            configuration: z.strictObject({
              /** Regular expressions flagged in addition to the built-in patterns; replaces the plugin's. */
              blockedPatterns: z.array(patternSchema).default(blockedPatterns),
            }),
            create: (agent: { readonly blockedPatterns: readonly string[] }) =>
              createCodeSafetyValidator({
                blockedPatterns: agent.blockedPatterns.map((source) => new RegExp(source)),
              }),
          },
          {
            name: 'grounding',
            description:
              'Flags a reply whose URLs, amounts, measurements and quoted text mostly do not appear in the conversation.',
            configuration: z.strictObject({
              /** The share of a reply's claims that must appear in the conversation, from 0 to 1. */
              threshold: thresholdSchema.default(groundingThreshold),
            }),
            create: (agent: { readonly threshold: number }) =>
              createGroundingValidator({ groundingThreshold: agent.threshold }),
          },
        ],
      },
    };
  },
});
