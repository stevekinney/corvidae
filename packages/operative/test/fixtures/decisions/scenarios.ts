import type { DecisionRequest } from '../../../src/decisions/types';

/**
 * One request the Jev contract suite replays, and the answer the recording
 * must have produced. The recorder refuses to write a fixture whose decision
 * differs from `expected`, so a replay asserts the same value the live call gave.
 */
export interface DecisionScenario {
  /** The fixture's file name, without `.json`. */
  readonly name: string;
  readonly request: Exclude<DecisionRequest, { kind: 'structured' }>;
  readonly expected: boolean | string | number;
}

/** The requests recorded against the live Jev API by `scripts/record-decision-fixtures.ts`. */
export const decisionScenarios: readonly DecisionScenario[] = [
  {
    name: 'boolean-true',
    request: {
      kind: 'boolean',
      question: 'Is the customer asking for a refund?',
      context:
        'Hi, I was charged twice for my subscription this month. Please send the money back.',
    },
    expected: true,
  },
  {
    name: 'boolean-false',
    request: {
      kind: 'boolean',
      question: 'Is the customer asking for a refund?',
      context: 'Hello! How do I change the colour theme of the dashboard to dark mode?',
    },
    expected: false,
  },
  {
    name: 'boolean-without-context',
    request: { kind: 'boolean', question: 'Is 7 a prime number?' },
    expected: true,
  },
  {
    name: 'choice',
    request: {
      kind: 'choice',
      question: 'Which team should handle this ticket?',
      context: 'I was charged twice for my subscription this month and need an invoice correction.',
      options: [
        { key: 'billing', label: 'Payments, invoices, refunds' },
        { key: 'tech', label: 'Bugs, outages, integrations' },
        { key: 'sales', label: 'Pricing, upgrades, new accounts' },
      ],
    },
    expected: 'billing',
  },
  {
    name: 'scale',
    request: {
      kind: 'scale',
      question: 'How urgent is this ticket?',
      context:
        'Our production checkout has been down for every customer for two hours and we are losing orders.',
      levels: ['low', 'medium', 'high'],
    },
    expected: 2,
  },
];
