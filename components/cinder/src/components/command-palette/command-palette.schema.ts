import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    open: {
      type: 'boolean',
      description:
        'Bindable open state. The component mutates `open = false` on Escape,\nbackdrop click, or any explicit close path, then fires `onClose`.',
    },
    placeholder: {
      type: 'string',
      description: 'Placeholder rendered inside the search input.',
    },
    label: {
      type: 'string',
      description: 'Accessible name for the dialog, wired via `aria-label`.',
    },
    query: {
      type: 'string',
      description:
        "Bindable search query. Mutated by the input's oninput handler.\nExposed to the items snippet so consumers can filter.\nReset to an empty string each time the palette opens.",
    },
    sheetBelow: {
      anyOf: [
        {
          type: 'string',
        },
        {
          const: false,
        },
      ],
      description:
        'Viewport width below which the palette opens as a bottom sheet instead of a centred panel: it\ndocks to the bottom edge with a grabber, a search field with a Close button, 44px rows, and a\nheight capped so the list scrolls inside it. It rides above the on-screen keyboard and\nrespects the bottom safe area. A CSS length such as `"640px"`, or `false` to keep the centred\npanel at every width.',
      default: '640px',
    },
    escapeHint: {
      anyOf: [
        {
          type: 'string',
        },
        {
          const: false,
        },
      ],
      description:
        'The key hint at the end of the search field, drawn as a `Kbd` ("esc"), which says how to close\nthe palette. `false` leaves it out. The bottom sheet shows a Close button instead and never\nthe hint.',
      default: 'esc',
    },
    closeLabel: {
      type: 'string',
      description:
        'Accessible name and visible text of the Close button the sheet form shows beside the search\nfield.',
      default: 'Close',
    },
    class: {
      type: 'string',
      description: 'Class merged onto the palette panel.',
    },
  },
  additionalProperties: false,
  required: ['open'],
  metadata: {
    unsupportedProps: [
      {
        name: 'empty',
        reason: 'function-or-snippet',
        description: 'Rendered when zero items are registered after filtering.',
      },
      {
        name: 'footer',
        reason: 'function-or-snippet',
        description: 'Optional footer, e.g. for keybinding hints. Not part of the listbox.',
      },
      {
        name: 'items',
        reason: 'function-or-snippet',
        required: true,
        description: 'Receives the current query so consumers can filter.',
      },
      {
        name: 'onClose',
        reason: 'function-or-snippet',
        description: 'Fired after any close path routed through the palette close lifecycle.',
      },
      {
        name: 'triggerRef',
        reason: 'unknown-shape',
        description: 'Element to restore focus to on close. Falls back to `captureFocus()`.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
