import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'A bold lead for the banner, such as "1 change waits for a restart". With a `preset` it\nreplaces the preset\'s lead and sits inline before the words; otherwise it sits on its own line\nabove them.',
    },
    variant: {
      enum: ['neutral', 'info', 'success', 'warning', 'danger'],
      description: "Visual + semantic variant. Default `'info'`.",
      default: 'info',
    },
    dismissible: {
      type: 'boolean',
      description:
        'Whether the banner shows a dismiss (×) button. Default `true`. A banner with a `preset` is\nnever dismissible: the connection and restart states cannot be hidden.',
      default: true,
    },
    preset: {
      enum: [
        'offline',
        'unreachable',
        'stopped',
        'out-of-date',
        'refresh-failed',
        'restarting',
        'reconnecting',
        'restart-failed',
        'back-online',
      ],
      description:
        'Applies a ready-made configuration: the tone, the accessible name, the words, a glyph and the\nactions of a connection or restart state (see {@link BannerPreset}). The preset overrides\n`variant`, makes the banner non-dismissible and, when `children` is omitted, writes its copy\nfrom `dataUpdatedAt`, `subject`, `retryInSeconds`, `attempt` and `consequence`. Passing\n`children` replaces the generated words and keeps the rest.',
    },
    retryLabel: {
      type: 'string',
      description:
        'Label of the Retry button. A preset labels it "Retry now" unless this says otherwise.',
      default: 'Retry',
    },
    retryVariant: {
      enum: ['primary', 'secondary'],
      description:
        'How prominent the Retry button is. A preset makes it `primary` where Retry now is the way back\n(`stopped`) and `secondary` everywhere else, so one action at a time looks primary.',
    },
    staleDataLabel: {
      type: 'string',
      description: 'Text that precedes the relative time in the stale-data notice.',
      default: 'Showing data from',
    },
    subject: {
      type: 'string',
      description:
        'What the page is showing, completing the preset\'s "Showing … as of …" sentence.',
      default: 'what loaded',
    },
    retryInSeconds: {
      type: 'number',
      description: 'Seconds until the next automatic retry. A preset writes "Retrying in 4 s".',
    },
    attempt: {
      type: 'number',
      description: 'The attempt under way, counted from 1. A preset writes "(attempt 3 of 8)".',
    },
    maxAttempts: {
      type: 'number',
      description: 'How many attempts there are.',
      default: 8,
    },
    consequence: {
      anyOf: [
        {
          type: 'string',
        },
        {
          const: false,
        },
      ],
      description:
        "The sentence that says what is off while the banner shows, replacing the preset's own. Pass\n`false` to leave the sentence out.",
    },
    timeZone: {
      type: 'string',
      description: 'IANA time zone of the preset\'s "as of" time. Defaults to the viewer\'s zone.',
    },
    titleLayout: {
      enum: ['inline', 'stacked'],
      description:
        'Where the title sits. A preset runs it inline, as the first words of its sentence; a banner\nwithout a preset puts it on its own line above the message.',
    },
    sticky: {
      type: 'boolean',
      description:
        'Keeps the banner at the top of its scroll container while the page scrolls under it.',
    },
    healthHref: {
      type: 'string',
      description: 'Makes "Open Health" a link to this address instead of a button.',
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
        description: 'Banner body content. Optional with a `preset`, which writes its own words.',
      },
      {
        name: 'dataUpdatedAt',
        reason: 'unknown-shape',
        description:
          'When the data still on screen was last loaded. With a `preset` and no `children` the copy names\nit as an absolute time with its zone ("as of 10:44 AM CST"). Otherwise it adds a stale-data\nnotice that reads "Showing data from" followed by a live relative time such as "2 minutes ago".',
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
        description:
          'A glyph at the start of the banner, drawn decoratively (`aria-hidden`). The `offline`,\n`unreachable` and `stopped` presets supply their own connection glyph.',
      },
      {
        name: 'onDismiss',
        reason: 'function-or-snippet',
        description: 'Called after the dismiss button is clicked. Use to persist state.',
      },
      {
        name: 'onOpenHealth',
        reason: 'function-or-snippet',
        description:
          'Called when the `restart-failed` preset\'s secondary action, "Open Health", is pressed.',
      },
      {
        name: 'onRestart',
        reason: 'function-or-snippet',
        description:
          'Called when the `restart-failed` preset\'s primary action, "Restart again", is pressed.',
      },
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Called when the Retry button is pressed. The button renders in the actions region, before\n`actions`, only when this is set. A preset that retries (`offline`, `unreachable`, `stopped`,\n`refresh-failed`, `reconnecting`) offers it only when this is set; `restarting`,\n`restart-failed` and `back-online` never offer it.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
