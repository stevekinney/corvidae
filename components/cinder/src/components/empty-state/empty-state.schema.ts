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
      enum: ['first-use', 'filtered', 'done', 'blocked', 'not-found', 'disabled'],
      description:
        "Why the view is empty. It sets the disc tint and the default glyph (first use, filtered, done, blocked, not found or disabled).\nEvery kind renders the `action` snippet; `'filtered'` also adds a secondary \"Clear filters\"\nbutton before it when `onClearFilters` is set. Give `'first-use'` a primary button, `'done'`\na quiet `Link`, and `'filtered'` the Clear filters button alone.",
      default: 'first-use',
    },
    size: {
      enum: ['default', 'compact'],
      description:
        "Scale of the state. `'compact'` tightens the padding, disc, and type so the state fits a\ntab or a panel rather than a whole page region.",
      default: 'default',
    },
    layout: {
      enum: ['stacked', 'inline'],
      description:
        '`\'inline\'` draws a 32px disc beside the title and the sentence on one line, at the inline\nstart, without the vertical padding of a region. Use it with `size="compact"`.',
      default: 'stacked',
    },
    bordered: {
      type: 'boolean',
      description:
        'Draws the state inside a bordered, rounded box, for a list or page body that has no\ncontainer of its own. Leave it off when a card or panel already surrounds the state.',
      default: false,
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
          'Call-to-action content rendered below the description, after the "Clear filters" button when\nboth exist. A primary `Button` for first use, a `Link` (accent, underlined only on hover) for\ndone, and a secondary button for a not-found or blocked state.',
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
        description:
          "Replaces the glyph in the disc. First use shows the view's own icon; every other kind has a\ndefault glyph. Decorative, so it is hidden from assistive technology.",
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

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
