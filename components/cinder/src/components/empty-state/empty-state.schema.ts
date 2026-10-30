import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'Primary heading text rendered as a heading element at the configured `headingLevel`.',
    },
    description: {
      type: 'string',
      description: 'Secondary descriptive text rendered as a paragraph below the title.',
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-empty-state` root element.',
    },
    headingLevel: {
      enum: [1, 2, 3, 4, 5, 6],
      description: 'Heading level for the title element.',
      default: 3,
    },
    align: {
      enum: ['center', 'start'],
      description:
        "Alignment of the content. `'center'` centres the icon, text, and action in\nthe region; `'start'` aligns them to the inline start, for a state that\nreads as instructions rather than a placeholder.",
      default: 'center',
    },
    kind: {
      enum: ['first-use', 'filtered', 'done'],
      description:
        "Why the view is empty. `'first-use'` shows the `action` snippet, `'filtered'` adds a\n\"Clear filters\" button when `onClearFilters` is set, and `'done'` shows no action at all,\neven when `action` is passed, because there is nothing left to do.",
      default: 'first-use',
    },
    size: {
      enum: ['default', 'compact'],
      description:
        "Scale of the state. `'compact'` tightens the padding, disc, and type so the state fits a\ntab or a panel rather than a whole page region.",
      default: 'default',
    },
    clearFiltersLabel: {
      type: 'string',
      description: 'Label of the "Clear filters" button.',
      default: 'Clear filters',
    },
  },
  additionalProperties: false,
  required: ['title'],
  metadata: {
    unsupportedProps: [
      {
        name: 'action',
        reason: 'function-or-snippet',
        description:
          'Call-to-action content rendered below the description, after the "Clear filters" button when both exist.',
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
        description:
          'Icon rendered above the title, centred in a tinted disc. Decorative, so it is hidden from assistive technology.',
      },
      {
        name: 'onClearFilters',
        reason: 'function-or-snippet',
        description:
          'Called when the "Clear filters" button of a `\'filtered\'` state is pressed. The button renders only when this is set.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
