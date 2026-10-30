import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    variant: {
      enum: ['info', 'success', 'warning', 'danger'],
      description: "Visual + semantic variant. Default `'info'`.",
      default: 'info',
    },
    dismissible: {
      type: 'boolean',
      description: 'Whether the banner shows a dismiss (×) button. Default `true`.',
      default: true,
    },
    preset: {
      const: 'unreachable',
      description:
        "Applies a ready-made configuration. `'unreachable'` overrides `variant` with `'warning'` and\nnames the region \"Connection problem\" unless `aria-label` or `aria-labelledby` is passed.\nPair it with `onRetry` and `dataUpdatedAt`.",
    },
    retryLabel: {
      type: 'string',
      description: 'Label of the Retry button.',
      default: 'Retry',
    },
    staleDataLabel: {
      type: 'string',
      description: 'Text that precedes the relative time in the stale-data notice.',
      default: 'Showing data from',
    },
    class: {
      type: 'string',
      description:
        'Extra classes appended to the root element. Pass via the explicit\n`class` prop — it is excluded from rest-prop spread, so writing\n`class="x"` inside spread attributes will not reach the root.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'actions',
        reason: 'function-or-snippet',
        description: 'Optional trailing CTA region (e.g., "Renew now" button).',
      },
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Banner body content.',
      },
      {
        name: 'dataUpdatedAt',
        reason: 'unknown-shape',
        description:
          'When the data still on screen was last fetched. Adds a stale-data notice that reads\n"Showing data from" followed by a live relative time such as "2 minutes ago".',
      },
      {
        name: 'onDismiss',
        reason: 'function-or-snippet',
        description: 'Called after the dismiss button is clicked. Use to persist state.',
      },
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Called when the Retry button is pressed. The button renders in the actions region, before `actions`, only when this is set.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
