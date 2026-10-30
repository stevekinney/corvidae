import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    currentPage: {
      type: 'number',
      description:
        'Current page number (1-indexed). Bindable. In callback mode it only feeds the "Page N of M"\nlabel, so cursor paging can omit it.',
      default: 1,
    },
    totalPages: {
      type: 'number',
      description: 'Total number of pages. Omit when only previous/next availability is known.',
    },
    hasPreviousPage: {
      type: 'boolean',
      description:
        'Whether a previous page is available. When totalPages is unknown, defaults to currentPage > 1.\nIn callback mode (`onPrevious` or `onNext` given) Previous is enabled only when `onPrevious` is\ngiven and this is true.',
    },
    hasNextPage: {
      type: 'boolean',
      description:
        'Whether a next page is available. When totalPages is unknown, defaults to false. In callback\nmode (`onPrevious` or `onNext` given) Next is enabled only when `onNext` is given and this is\ntrue.',
      default: false,
    },
    totalCount: {
      type: 'number',
      description: 'Optional total record count; formatted with formatNumber when provided.',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-pagination`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'countLabel',
        reason: 'function-or-snippet',
        description:
          'Formats the `totalCount` text in place of the default "N results". Receives the raw count,\nso format it with your own locale rules.',
      },
      {
        name: 'onNext',
        reason: 'function-or-snippet',
        description:
          'Called when the user asks for the next page. Giving this or `onPrevious` puts the component\nin callback mode: `currentPage` is never changed by the component, Next is enabled when this\nis given and `hasNextPage` is true, and no page-number buttons render. When `totalPages` is given the\ncontrols show "Page N of M".',
      },
      {
        name: 'onPrevious',
        reason: 'function-or-snippet',
        description:
          'Called when the user asks for the previous page. Giving this or `onNext` puts the component\nin callback mode: `currentPage` is never changed by the component, Previous is enabled when\nthis is given and `hasPreviousPage` is true, and no page-number buttons render. Keep the offset\nor cursor in the caller.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
