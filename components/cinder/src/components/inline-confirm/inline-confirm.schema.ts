import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Confirmation prompt text.',
    },
    confirmLabel: {
      type: 'string',
      description: 'Label for the confirming action.',
    },
    cancelLabel: {
      type: 'string',
      description: "Label for the cancelling action. Defaults to `'Cancel'`.",
      default: 'Cancel',
    },
    destructive: {
      type: 'boolean',
      description: 'Marks the confirming action as destructive. Defaults to `false`.',
      default: false,
    },
    open: {
      type: 'boolean',
      description: 'Whether the confirmation is open. Bindable. Defaults to `false`.',
      default: false,
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  additionalProperties: false,
  required: ['confirmLabel', 'prompt'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        description:
          'Additional content rendered below the prompt, above the confirm/cancel actions, while the confirmation is open.',
      },
      {
        name: 'onCancel',
        reason: 'function-or-snippet',
        description: 'Called when the user cancels the action.',
      },
      {
        name: 'onConfirm',
        reason: 'function-or-snippet',
        description: 'Called when the user confirms the action.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
