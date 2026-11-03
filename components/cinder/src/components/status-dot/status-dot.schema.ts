import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    status: {
      enum: [
        'online',
        'offline',
        'warning',
        'danger',
        'info',
        'pending',
        'neutral',
        'success',
        'accent',
      ],
      description:
        'Semantic status. Drives color via `data-cinder-status`; defaults to a neutral dot or derives from `connectionState`. `success` maps to `--cinder-status-success-solid`; `info` maps to `--cinder-status-info-solid`; `pending` is a hollow ring; `accent` maps to `--cinder-accent-solid`.',
    },
    connectionState: {
      enum: ['connected', 'connecting', 'disconnected', 'error'],
      description:
        'Realtime connection preset. Sets status, default label, and live-region semantics.',
    },
    label: {
      type: 'string',
      description:
        'Human label. Rendered visibly when `labelVisible` is true; used as the accessible name either way. Defaults to a word derived from `status` (for example "Online"), so a bare StatusDot is a dot and a word, never a dot alone.',
    },
    labelVisible: {
      type: 'boolean',
      description: 'Whether to render the visible label.',
      default: true,
    },
    live: {
      type: 'boolean',
      description:
        'Use role="status" with polite live-region attributes. Defaults true when connectionState is provided.',
    },
    size: {
      enum: ['sm', 'md'],
      description: 'Dot size.',
      default: 'md',
    },
    wordTone: {
      enum: ['muted', 'status'],
      description:
        'How the visible word is coloured: `muted` (the default) leaves a success, neutral or pending word muted so the dot carries the tone; `status` paints it in the status\'s text colour, for a result sentence such as a green "Found 3 tools". Warning, danger and info words are always coloured.',
      default: 'muted',
    },
    class: {
      type: 'string',
      description: 'Extra classes appended to the root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'word',
        reason: 'unknown-shape',
        description:
          'A status word from the word-to-tone table, such as "Waiting on you" or "Failed". It sets both the tone and the visible word, so a page never picks its own tone; a qualifier after a middle dot ("Running · checking the result") rides along. An explicit `status` or `label` wins over what the word supplies.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
