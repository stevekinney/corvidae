import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Stable identity of the call; used as the keyed row identity and passed to `onSelect`.',
          },
          name: {
            type: 'string',
            description: 'The tool\'s name as a person reads it ("Lookup order"). It never wraps.',
          },
          identifier: {
            type: 'string',
            description: 'The tool\'s identifier ("lookup-order"), shown in a tooltip on the name.',
          },
          input: {
            type: 'string',
            description:
              'The key input of the call, muted and cut with an ellipsis ("4471", "carrier Parcelly, damaged").',
          },
          result: {
            type: 'string',
            description:
              'What came back, in one line. A `done`, `approved` or `failed` call shows it after an arrow\n("→ $42.00, delivered Mon"); a `denied` call shows it as its own words ("Denied by you 10:40 AM ·\nnothing refunded"); a `running` or `waiting` call has none and reads "Running…" or "Waiting on\nyou", unless this is set.',
          },
          decision: {
            type: 'string',
            description:
              'What a person decided, in their own words and without an arrow: "Approved by you 10:33 AM ·\n$18.50 refunded" on an `approved` call, or "Denied by you 10:40 AM · nothing refunded" on a\n`denied` one. It takes the place of `result` on the row; without it an `approved` call shows\nits `result` after an arrow like a `done` one.',
          },
          duration: {
            type: 'string',
            description:
              'How long the call took, formatted by the caller ("0.2s"), at the end of the row. Elapsed while `running`.',
          },
          status: {
            enum: ['done', 'approved', 'running', 'waiting', 'denied', 'failed'],
            description: 'Where the call stands.',
          },
          failure: {
            type: 'string',
            description:
              'For a `failed` call: the consequence in one danger-text line under the row ("Mail server didn\'t\nreply within 10s. The refund notice for 4471 wasn\'t sent."). The row shows no filled error\nblock.',
          },
          nested: {
            type: 'boolean',
            description:
              "Whether the `children` snippet draws content under this call's row, such as the approval that\na `waiting` call is waiting on, or the approved one under a call that has been decided.",
          },
        },
        additionalProperties: false,
        required: ['id', 'name', 'status'],
      },
      description: 'The calls of one turn, in the order they were made.',
    },
    running: {
      type: 'boolean',
      description: 'Whether the turn is still running.',
      default: false,
    },
    duration: {
      type: 'string',
      description: 'How long the whole turn took, formatted by the caller.',
    },
    open: {
      type: 'boolean',
      description: 'Whether the rail is open.',
      default: true,
    },
    selectedId: {
      type: 'string',
      description: 'The call whose panel is open.',
    },
    endLabel: {
      type: 'string',
      description: "The run's end state, on its own line after the last row.",
    },
    footnote: {
      type: 'string',
      description: 'A muted line under the rail.',
    },
    label: {
      type: 'string',
      description: 'An accessible name for the rail.',
      default: 'Tool calls',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-tool-call-rail`.',
    },
  },
  additionalProperties: false,
  required: ['calls'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        description:
          "Content under a call's row: the approval a `waiting` call is waiting on. Drawn for the calls that set `nested`.",
      },
      {
        name: 'onCopyInput',
        reason: 'function-or-snippet',
        description:
          "Fired when the person copies a failed call's input. The link shows only when this is set.",
      },
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Fired when the person asks the agent to retry a failed call. The link shows only when this is set.',
      },
      {
        name: 'onSelect',
        reason: 'function-or-snippet',
        description:
          "Fired with a call's id when its row is chosen. Rows are buttons only when this is set.",
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
