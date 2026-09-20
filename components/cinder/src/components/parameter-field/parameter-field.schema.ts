import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Stable id used for label and output association.',
    },
    label: {
      type: 'string',
      description: 'Visible parameter label.',
    },
    base: {
      type: 'number',
      description: 'Inherited or default numeric value.',
    },
    override: {
      type: 'number',
      description: 'Optional local numeric override. Bindable.',
    },
    unit: {
      type: 'string',
      description: 'Optional unit appended to the value and reset tooltip.',
    },
    unsaved: {
      type: 'boolean',
      description: 'Marks the current override as not yet persisted. Defaults to `false`.',
      default: false,
    },
    experimental: {
      type: 'boolean',
      description: 'Marks the parameter as experimental. Defaults to `false`.',
      default: false,
    },
    class: {
      type: 'string',
      description: 'Additional class merged with `.cinder-parameter-field`.',
    },
  },
  additionalProperties: false,
  required: ['base', 'id', 'label'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        description:
          'Optional custom numeric editor. Receives the effective value and override setter.',
      },
      {
        name: 'onOverrideChange',
        reason: 'function-or-snippet',
        description:
          "Called when the component's own `setOverride` (exposed to `children`\nas `ParameterFieldEditorState.setOverride`) or its built-in reset\naction changes the override. Not called when a parent changes the\nbindable `override` prop programmatically—that update is not\ndistinguishable here from the component's own writes.",
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
