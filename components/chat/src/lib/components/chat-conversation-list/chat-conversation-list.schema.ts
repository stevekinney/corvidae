import type { ComponentSchema } from '../../schema-types.ts';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    activeConversationId: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'null',
        },
      ],
      description: 'Currently active conversation id.',
    },
    ariaLabel: {
      type: 'string',
      description:
        'Accessible name for the conversations navigation landmark. Default `"Conversations"`.',
    },
    emptyText: {
      type: 'string',
      description:
        'Empty state text when no conversations are present. Default `"No conversations"`.',
    },
    class: {
      type: 'string',
      description: 'Additional class name merged with `.cinder-chat-conversation-list`.',
    },
    hasMore: {
      type: 'boolean',
      description:
        'Whether more conversations are available. The load-more control renders only while this is `true`. Default `false`.',
    },
    loading: {
      type: 'boolean',
      description:
        'Whether a page is loading. Disables the load-more button and marks it busy. Default `false`.',
    },
    buttonLabel: {
      type: 'string',
      description: 'Visible label for the load-more button. Default `"Load more"`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'conversations',
        reason: 'unknown-shape',
        required: true,
        description:
          'Conversation summaries to render. Sorts by latest message/update time descending.',
      },
      {
        name: 'onSelectConversation',
        reason: 'function-or-snippet',
        description: 'Called when a conversation is selected.',
      },
      {
        name: 'onLoadMore',
        reason: 'function-or-snippet',
        description:
          "Called when the next page of conversations should load, which is when the\nuser scrolls to the end of the list or activates the load-more button.\nProviding it, with `hasMore`, renders Cinder's `LoadMore` after the last\nrow. The host supplies the rows and flips `hasMore` and `loading`.",
      },
      {
        name: 'onError',
        reason: 'function-or-snippet',
        description: 'Called when `onLoadMore` throws or rejects.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
