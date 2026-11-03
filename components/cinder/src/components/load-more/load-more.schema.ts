import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    hasMore: {
      type: 'boolean',
      description: 'Whether more items are available. Bindable.',
    },
    loading: {
      type: 'boolean',
      description: 'Whether a load is in progress. Bindable.',
    },
    rootMargin: {
      type: 'string',
      description: 'rootMargin passed to IntersectionObserver. Captured at attachment time.',
    },
    buttonLabel: {
      type: 'string',
      description: 'Visible label for the load-more button.',
      default: 'Load more',
    },
    retryLabel: {
      type: 'string',
      description: 'Visible label for the retry button after a load error.',
      default: 'Try again',
    },
    loadedCount: {
      type: 'number',
      description:
        'How many items the list shows now. With `totalCount` the footer reads "Showing 10 of 19" next\nto its button, and keeps that count when a load fails.',
    },
    totalCount: {
      type: 'number',
      description: 'How many items exist in all; pairs with `loadedCount`.',
    },
    itemLabel: {
      type: 'string',
      description:
        'What the list holds, in the plural, for the failure message: "runs" gives "Couldn’t load more\nruns."',
      default: 'items',
    },
    errorMessage: {
      type: 'string',
      description:
        'Replaces the whole failure message shown after `onLoadMore` rejects. By default it reads\n"Couldn’t load more {itemLabel}." followed by the count when `loadedCount` and `totalCount`\nare set.',
    },
    endOfListMessage: {
      type: 'string',
      description: 'Politely announced when the end of the list is reached.',
      default: 'End of list',
    },
    maxRetries: {
      type: 'number',
      description: 'Maximum consecutive sentinel-triggered requests before auto-loading pauses.',
      default: 5,
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-load-more`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'onError',
        reason: 'function-or-snippet',
        description: 'Notified when onLoadMore throws or rejects.',
      },
      {
        name: 'onLoadMore',
        reason: 'function-or-snippet',
        description:
          'Called when the next page should be loaded. Caller flips `loading` and `hasMore`.',
      },
      {
        name: 'root',
        reason: 'unknown-shape',
        description:
          'Scroll container the sentinel is observed within. Pass the scrollable\nancestor element when the list scrolls inside a container rather than the\nviewport. `null`/omitted observes against the viewport. Captured at\nattachment time.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
