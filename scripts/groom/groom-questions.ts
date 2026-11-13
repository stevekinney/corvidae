// The questions `groom.ts` asks Jev about a Backlog issue, and the thresholds that turn each answer
// into an action. Every piece of wording and every threshold the groomer uses lives here, so a
// change to what is asked is a change to this file alone.
//
// Jev answers judgments; the code in `groom.ts` decides. Each question asks one thing a person
// could answer at a glance from the issue alone, and refers to the issue as "this issue".

import type { DecisionOption, DecisionQuestion } from '@lostgradient/operative';
import type { PriorityName } from '../chef/linear.ts';

/** A yes above this reads as yes. */
export const yesThreshold = 0.7;
/** A yes below this reads as no; between the two thresholds the question is unsettled. */
export const noThreshold = 0.3;

/** Linear's priorities from least to most pressing, the order of {@link priorityLevels}. */
export const priorityOrder: readonly PriorityName[] = ['low', 'medium', 'high', 'urgent'];

/** Each priority as a situation, in {@link priorityOrder}. */
export const priorityLevels: readonly string[] = [
  'A nice-to-have: cleanup, polish, or a follow-up nobody is waiting on.',
  'Normal planned work: a feature or fix that should land in the course of the current work.',
  'Other planned work waits on this, or a defect that people or the main branch hit regularly.',
  'The main branch, a deployment, or people using the product are broken now, and work is stopped until it is fixed.',
];

export const priorityQuestion: DecisionQuestion = {
  kind: 'scale',
  question: 'How pressing is the work this issue describes?',
  levels: priorityLevels,
};

/** The Work Type labels the groomer may choose, with what each one means. `type:decision` is never offered. */
export const workTypeOptions: readonly DecisionOption[] = [
  {
    key: 'type:feature',
    label: 'New capability or new behavior that people using the product or the tools will notice.',
  },
  {
    key: 'type:bug',
    label:
      'Something that exists behaves wrongly: a defect, a failing or flaky test, a regression.',
  },
  {
    key: 'type:chore',
    label:
      'Maintenance with no new behavior: refactoring, tooling, dependencies, documentation, tests that only cover existing behavior.',
  },
  {
    key: 'type:release',
    label:
      'Shipping something that is built: a deployment, a published package, a verified rollout.',
  },
  {
    key: 'type:adoption',
    label: 'Moving existing callers onto something new that already shipped.',
  },
];

export const workTypeQuestion: DecisionQuestion = {
  kind: 'choice',
  question: 'Which kind of work does this issue describe?',
  options: workTypeOptions,
};

/** The yes/no question for one package label, built from the workspace it names. */
export function packageQuestion(workspace: string, about: string): DecisionQuestion {
  return {
    kind: 'boolean',
    question: `Does the work in this issue change code in the \`${workspace}\` workspace (${about})?`,
  };
}

/**
 * The Definition of Ready predicates that need judgment. `passWhen` says which answer passes:
 * `yes` passes above {@link yesThreshold}, `no` passes below {@link noThreshold}; anything else is
 * a failure, with the unsettled band reported apart from a clear failure.
 */
export interface ReadinessQuestion {
  readonly name: string;
  /**
   * The section the question judges, by lower-case heading. When the issue lacks it, the question
   * is not asked: the mechanical check already fails the missing section.
   */
  readonly section?: string;
  readonly question: DecisionQuestion;
  readonly passWhen: 'yes' | 'no';
  /** What a failure means, as the groom comment states it. */
  readonly failure: string;
}

export const readinessQuestions: readonly ReadinessQuestion[] = [
  {
    name: 'criteria-binary',
    section: 'acceptance criteria',
    question: {
      kind: 'boolean',
      question:
        'Can each item in the acceptance criteria of this issue be checked as pass or fail by running a command or reading a file or screen?',
    },
    passWhen: 'yes',
    failure: 'Not every acceptance criterion is a pass-or-fail check.',
  },
  // Whether Verification's commands run is code's to check, not Jev's: `triage.ts` requires
  // commands there and resolves every cited `bun run` script and path against origin/main.
  {
    name: 'delivery-concrete',
    section: 'delivery boundary',
    question: {
      kind: 'boolean',
      question:
        'Does the Delivery boundary section of this issue name one concrete thing whose existence ends the work, such as a merged pull request or a deployment?',
    },
    passWhen: 'yes',
    failure: 'The delivery boundary names no concrete artifact that ends the work.',
  },
  {
    name: 'no-open-choice',
    question: {
      kind: 'boolean',
      question:
        'Does this issue leave a product, design or scope choice unmade that the owner has to make before the work can start? Two ways of implementing it that the person doing the work may pick between are not such a choice.',
    },
    passWhen: 'no',
    failure: 'The issue leaves a choice for the owner to make.',
  },
];
