import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    version: {
      type: 'string',
      description: 'Version window claims are filtered against.',
    },
    storageKey: {
      type: 'string',
      description: 'Key used to namespace dismissal state in the storage adapter.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'anchorResolver',
        reason: 'function-or-snippet',
        description: 'Resolves a claim anchor using consumer-owned DOM knowledge.',
      },
      {
        name: 'children',
        reason: 'function-or-snippet',
        description: 'Descendant application surface that consumes guidance through `useGuidance`.',
      },
      {
        name: 'claims',
        reason: 'unknown-shape',
        description: 'Registered guidance claims available to descendants through `useGuidance`.',
      },
      {
        name: 'storage',
        reason: 'unknown-shape',
        description:
          'Adapter used to persist which claims a user has dismissed, so dismissal survives a reload.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
