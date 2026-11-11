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
    presentation: {
      enum: ['strip', 'two-press'],
      description: 'The in-flow strip (default) or a single guarded action button.',
      default: 'strip',
    },
    armedLabel: {
      type: 'string',
      description: 'Full accessible label shown after the first press in two-press presentation.',
    },
    requestKey: {
      type: 'string',
      description: 'Request identity; changing it disarms two-press presentation.',
    },
    disabled: {
      type: 'boolean',
      description: 'Disables and disarms two-press presentation.',
      default: false,
    },
    armedHint: {
      type: 'string',
      description: 'Status text shown while the two-press action is armed.',
    },
    loading: {
      type: 'boolean',
      description: 'Shows a loading state on the action button.',
      default: false,
    },
    loadingLabel: {
      type: 'string',
      description: 'Accessible loading label for the action button.',
    },
    ariaDescribedBy: {
      type: 'string',
      description: "Id referenced by the action button's aria-describedby.",
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
    flush: {
      type: 'boolean',
      description:
        "The strip sits flush inside a bordered container. At the container's start or end it drops\nits own rule there instead of doubling the container's edge. Defaults to `false`.",
      default: false,
    },
    open: {
      type: 'boolean',
      description:
        'Whether the confirmation is open. Bindable, and component-owned on\nclose: confirming, clicking Cancel, and pressing Escape all set this\nto `false` before calling `onConfirm`/`onCancel`, so a bound parent\nobserves the confirmation as already closed by the time either\ncallback runs—neither callback can veto or delay that close. Defaults\nto `false`.',
      default: false,
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  additionalProperties: false,
  required: ['confirmLabel'],
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
        description:
          'Called when the user cancels the action (via the Cancel action or Escape), after `open` is already set to `false`.',
      },
      {
        name: 'onConfirm',
        reason: 'function-or-snippet',
        description:
          'Called when the user confirms the action, after `open` is already set to `false`.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
