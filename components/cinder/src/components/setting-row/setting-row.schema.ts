import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Stable id shared with the composed control.',
    },
    label: {
      type: 'string',
      description: 'Visible setting label.',
    },
    description: {
      type: 'string',
      description: 'Guidance text describing the setting.',
    },
    warning: {
      type: 'string',
      description: 'Advisory message forwarded through `FormField` context.',
    },
    error: {
      type: 'string',
      description: 'Corrective error message forwarded through `FormField` context.',
    },
    required: {
      type: 'boolean',
      description:
        "Renders the required marker and forwards `required` into `FormField`\ncontext. Only takes effect for a control that opts into and reads that\ncontext—it never adds a native `required` attribute, so a control that\ndoesn't consume the context still passes browser constraint validation\nand must receive `required` directly.",
    },
    disabled: {
      type: 'boolean',
      description:
        "Forwards a disabled state into `FormField` context for the row's\ncontrol. Only takes effect for a control that opts into and reads that\ncontext—a native element or a third-party component that doesn't\nconsume it stays interactive and must receive `disabled` directly.\nDoes not disable automatically while saving.",
    },
    managed: {
      type: 'object',
      properties: {
        by: {
          type: 'string',
          description: 'Policy or administrator that owns the value.',
        },
        reason: {
          type: 'string',
          description: 'Human-readable explanation for the constraint.',
        },
      },
      additionalProperties: false,
      description: 'Renders a managed-policy indicator; pair with `PolicyLock`.',
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  additionalProperties: false,
  required: ['id', 'label'],
  metadata: {
    unsupportedProps: [
      {
        name: 'control',
        reason: 'function-or-snippet',
        required: true,
        description: "The setting's control, rendered with `FormField` context applied.",
      },
      {
        name: 'disclosure',
        reason: 'function-or-snippet',
        description: 'Optional disclosure content rendered beneath the row.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
