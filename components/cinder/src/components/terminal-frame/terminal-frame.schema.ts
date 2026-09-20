import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Title shown in the frame chrome.',
    },
    status: {
      enum: ['connecting', 'connected', 'disconnected', 'error'],
      description: "Connection status shown in the frame chrome. Defaults to `'connecting'`.",
      default: 'connecting',
    },
    error: {
      type: 'string',
      description:
        "Recovery error message. The recovery UI is gated on `error` alone, not\non `status`—if `error` stays set after `status` moves away from\n`'error'` (for example to `'connected'`), the recovery UI remains\nvisible until the caller clears `error` too.",
    },
    columnWidth: {
      type: 'number',
      description:
        'Character-cell width, in pixels, used to compute `{ cols, rows }` on\nresize. Must be positive and finite for a new measurement to run (see\n`onDimensionsChange` for the one exception). Defaults to `8`.',
      default: 8,
    },
    rowHeight: {
      type: 'number',
      description:
        'Character-cell height, in pixels, used to compute `{ cols, rows }` on\nresize. Must be positive and finite for a new measurement to run (see\n`onDimensionsChange` for the one exception). Defaults to `18`.',
      default: 18,
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  additionalProperties: false,
  required: ['title'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Consumer-owned PTY renderer.',
      },
      {
        name: 'onDimensionsChange',
        reason: 'function-or-snippet',
        description:
          "Called with `{ cols, rows }` whenever the character-cell size changes,\nso the host can resize its PTY. A new measurement is never taken—and\nthis never fires from one—while `columnWidth` or `rowHeight` is\nnon-finite or `<= 0`. That's not an absolute guarantee this never\nfires while invalid, though: the component replays the last valid\nmeasurement whenever the `onDimensionsChange` reference itself changes\n(e.g. a parent passing a new inline handler each render), and that\nreplay doesn't re-check `columnWidth`/`rowHeight`—so a stale\nmeasurement can still reach a newly-passed handler even after the\ncell size becomes invalid.",
      },
      {
        name: 'onReloadRequest',
        reason: 'function-or-snippet',
        description:
          'Called when the user requests a reload from the recovery UI. The\nrecovery UI (and this button) show whenever `error` is set, regardless\nof the current `status`.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
