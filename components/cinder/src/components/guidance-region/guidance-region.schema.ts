import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    version: {
      type: 'string',
      description:
        "Version window claims are filtered against. When omitted—or passed as\n`''`, which is treated identically to omitted, not as an invalid\nversion—every claim is relevant and neither claim's `relevantFrom` nor\n`relevantUntil` is validated; this matters if an unset environment\nvalue can reach this prop as `''`. When supplied non-empty, it must be\nSemVer-shaped\n(`major.minor.patch`, each numeric with no leading zero, an optional\n`-prerelease`/`+build` suffix)—a shortened form like `'1.2'` fails to\nparse. The parser is looser than strict SemVer in one respect: it\ndoesn't reject an empty dot-separated identifier inside a\n`-prerelease`/`+build` suffix (e.g. `'1.0.0-alpha..1'` still parses).\nIf this non-empty `version` itself fails to parse, every claim is\nfiltered out—the whole registry silently goes empty, not just the\nclaims with malformed bounds. A claim's `relevantFrom`/`relevantUntil`\nare parsed the same way; if either fails to parse, only that claim is\nfiltered out.",
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
        description:
          "Resolves a claim anchor using consumer-owned DOM knowledge. Required\nfor any claim that isn't `kind: 'modal'`—which includes the default\ncase where `kind` is omitted: without `anchorResolver` (or when it\nresolves to a disconnected element), that claim can never be claimed\nand its guidance can never open. Omit this prop only when every\nregistered claim is `kind: 'modal'`.",
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
