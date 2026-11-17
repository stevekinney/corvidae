import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    currentStep: {
      type: 'number',
      description:
        "Zero-based index of the active step in the `'stepper'` variant. Steps with index <\ncurrentStep are \"completed\". Pass `steps.length` to mark every step as complete (terminal\n\"done\" state). The `'checklist'` and `'status'` variants ignore it and read each step's\n`done` instead.",
      default: 0,
    },
    variant: {
      enum: ['stepper', 'checklist', 'status'],
      description:
        "Which list the steps render as: `'stepper'` is the ordered wizard indicator, `'checklist'` is\na card of rows that each carry an action, and `'status'` is a list of progress by step.",
      default: 'stepper',
    },
    orientation: {
      enum: ['horizontal', 'vertical'],
      description:
        "Layout direction of the `'stepper'` variant. The `'checklist'` and `'status'` variants are\nalways vertical. Defaults to 'horizontal'.",
      default: 'horizontal',
    },
    heading: {
      type: 'string',
      description:
        "Title of the `'checklist'` card, such as \"Get started\". It sits at the start of the card's\nheader row, with the counter at the end, and names the section.",
    },
    headingLevel: {
      enum: [1, 2, 3, 4, 5, 6],
      description: 'Heading level for `heading`.',
      default: 3,
    },
    currentLabel: {
      type: 'string',
      description:
        "Visually-hidden text announced for the step in progress in the `'status'` variant.",
      default: 'In progress',
    },
    pendingLabel: {
      type: 'string',
      description:
        "Visually-hidden text announced for a step that hasn't started in the `'status'` variant.",
      default: 'Pending',
    },
    label: {
      type: 'string',
      description:
        "Accessible name for the wrapper: the nav landmark of the `'stepper'`, the status region of\nthe `'status'` variant, and the section of a `'checklist'` that has no `heading`. Defaults to\n'Progress'.",
      default: 'Progress',
    },
    completedLabel: {
      type: 'string',
      description:
        "Visually-hidden text prepended to completed steps so screen readers\nannounce state + label. Defaults to 'Completed'.",
      default: 'Completed',
    },
    skippedLabel: {
      type: 'string',
      description:
        "Visually-hidden text prepended to skipped steps so screen readers announce\nstate + label. Defaults to 'Skipped'.",
      default: 'Skipped',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-steps`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'progressLabel',
        reason: 'function-or-snippet',
        description:
          'Text of the counter at the end of the `\'checklist\'` header, from how many steps are done and\nhow many there are. Defaults to "N of M done".',
      },
      {
        name: 'steps',
        reason: 'unknown-shape',
        required: true,
        description: 'Ordered list of step entries from first to last.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
