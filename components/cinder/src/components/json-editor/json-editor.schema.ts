import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    disabled: {
      type: 'boolean',
      description: 'Disables the editor. A disabled field is not posted with its form.',
    },
    readonly: {
      type: 'boolean',
      description:
        'Makes the editor read-only. The toolbar reads "Read only" and has no Format button. A read-only field stays focusable and selectable and is posted with its form, but cannot be edited or formatted.',
    },
    required: {
      type: 'boolean',
      description:
        'Marks the editor as required. An empty value is valid and reads "Not set" unless the field is required.',
    },
    rows: {
      type: 'number',
      description:
        'The most lines the editor shows before it scrolls. It grows with its content from a three-line minimum up to this height, so a short value is not a large empty box. Defaults to 8.',
      default: 8,
    },
    id: {
      type: 'string',
      description: 'Unique identifier used for the label and feedback relationships.',
    },
    value: {
      type: 'string',
      description: 'Controlled JSON source text.',
    },
    label: {
      type: 'string',
      description: 'Visible label for the editor.',
    },
    description: {
      type: 'string',
      description: 'Supporting text announced with the editor.',
    },
    error: {
      type: 'string',
      description: 'External validation error. Takes precedence over JSON parse feedback.',
    },
    validFeedbackVisible: {
      type: 'boolean',
      description:
        'Whether valid JSON should render an announced success message. Defaults to true.',
      default: true,
    },
    statusLabel: {
      type: 'string',
      description:
        'Replaces the toolbar\'s "Valid JSON" status while the source parses, for a caller whose own validation says more, such as "Valid JSON, not a valid workflow". Never replaces an invalid or empty status.',
    },
    example: {
      type: 'string',
      description:
        'The sample that shows muted, after "e.g.", while the editor is empty, such as `{ "timeoutSeconds": 300 }`. Defaults to `{ "key": "value" }`. A `placeholder` replaces the whole text.',
    },
    wrap: {
      enum: ['soft', 'hard', 'off'],
      description:
        "How a line longer than the editor is shown. Left unset, it scrolls sideways inside the editor\nwith the line-number gutter fixed, and wraps below 640px, where sideways scrolling is hard to\nuse. `'off'` always scrolls; `'soft'` and `'hard'` always wrap.",
    },
    class: {
      type: 'string',
      description: 'Extra class names merged onto the field wrapper.',
    },
  },
  additionalProperties: false,
  required: ['id', 'label', 'value'],
  metadata: {
    unsupportedProps: [
      {
        name: 'diagnostics',
        reason: 'unknown-shape',
        description:
          'Problems the caller found at specific lines of a document that parses. Each line is marked and shows its message under it.',
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description: 'Called with the proposed JSON source whenever the user edits the field.',
      },
      {
        name: 'schema',
        reason: 'unknown-shape',
        description:
          'A JSON Schema that drives property-name and value completion. Without one the editor offers no completions.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
