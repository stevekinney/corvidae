import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    version: {
      type: 'string',
      description:
        "Version window claims are filtered against. Must be strict SemVer\n(`major.minor.patch`, each numeric with no leading zero; an optional\n`-prerelease` and `+build` suffix are allowed)—a shortened form like\n`'1.2'` fails to parse. A claim's own `relevantFrom`/`relevantUntil`\nbounds are parsed the same way; if either fails to parse, that claim is\nfiltered out silently rather than erroring.",
    },
    storageKey: {
      type: 'string',
      description:
        "Key used to namespace dismissal state in the storage adapter. Defaults\nto `'cinder-guidance'`—regions sharing one storage adapter without an\nexplicit `storageKey` collide in that namespace.",
      default: 'cinder-guidance',
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
        description:
          'Registered guidance claims available to descendants through\n`useGuidance`. Defaults to `[]`. (`GuidanceClaim` is not expressible in\nJSON Schema, so this default only appears here in prose.)',
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
