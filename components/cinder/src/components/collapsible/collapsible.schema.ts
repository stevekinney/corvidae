import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    trigger: {
      type: 'string',
      description: 'Trigger label text. (The snippet form is template-only; see the type above.)',
    },
    open: {
      type: 'boolean',
      description:
        'Bindable open state. Without `bind:open`, this seeds local state and can be\nupdated by parent prop changes. Use `bind:open` for full parent/trigger\nsynchronization.',
      default: false,
    },
    disabled: {
      type: 'boolean',
      description: 'When true, the trigger cannot be toggled.',
      default: false,
    },
    triggerAriaLabel: {
      type: 'string',
      description:
        'Accessible name override for the trigger button. The runtime prop also\naccepts a state-aware function (`{ open, disabled } => string`), but JSON\nSchema can only model the string variant.',
    },
    triggerClass: {
      type: 'string',
      description: 'Additional class names applied to the disclosure trigger button.',
    },
    labelClass: {
      type: 'string',
      description: 'Additional class names applied to the trigger label wrapper.',
    },
    variant: {
      enum: ['default', 'flat', 'disclosure'],
      description:
        "Visual treatment. `'default'` is a bordered card with a raised trigger.\n`'flat'` drops the border, the raised trigger background, and the horizontal\npadding, so the disclosure reads as a row on the surrounding surface. Its trigger label is semibold.\n`'disclosure'` draws the trigger as `DisclosureTrigger`, the one inline disclosure (board row\nX3): a 14px muted chevron at the start and medium words, over its region with no box.\n`chevron` does not apply to it.",
      default: 'default',
    },
    framed: {
      type: 'boolean',
      description:
        "Keeps the frame of a Collapsible that sits inside another Collapsible's panel. Nested, a\ndisclosure is flat by default (a box inside a box reads as clutter); set this to keep the\nbordered card. It changes nothing for a Collapsible that is not nested.",
      default: false,
    },
    animated: {
      type: 'boolean',
      description: 'Whether opening and closing uses the slide transition.',
      default: true,
    },
    chevron: {
      enum: ['start', 'end'],
      description:
        "Where the chevron sits. `'end'` is at the trailing edge and points down, turning over when the\ndisclosure opens. `'start'` is before the label and points right, turning down when it opens.",
      default: 'end',
    },
    idBase: {
      type: 'string',
      description:
        'Base used to derive the trigger, label, and panel ARIA ids. Auto-generated when omitted.',
    },
    class: {
      type: 'string',
      description: 'Additional classes merged onto the root element.',
    },
  },
  additionalProperties: false,
  required: ['trigger'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Panel content shown when open.',
      },
      {
        name: 'leadingIcon',
        reason: 'function-or-snippet',
        description: 'Optional decorative icon rendered inside the disclosure trigger.',
      },
      {
        name: 'onToggle',
        reason: 'function-or-snippet',
        description:
          'Fired on every successful toggle with the next open state. Not called while disabled.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
