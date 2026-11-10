import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: "Primary heading text rendered inside the card's header region.",
    },
    headingLevel: {
      enum: [2, 3, 4, 5, 6],
      description:
        'Heading level for the generated title. Defaults to `3`. Set this so the\ncard title nests correctly within the surrounding document outline.',
    },
    description: {
      type: 'string',
      description: 'Optional subheading rendered as a paragraph below the title inside the header.',
    },
    href: {
      type: 'string',
      description: 'Destination URL that makes the entire card an anchor.',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-card`.',
    },
    variant: {
      enum: ['card', 'well', 'plain'],
      description:
        'Visual container style. `card` is raised; `well` is flatter and inset; `plain` is a heading on the page with no box.',
    },
    edge: {
      enum: ['none', 'border', 'shadow'],
      description:
        'The one edge the card draws: `none` (default), a `border`, or a `shadow`, never both. An interactive\ncard strengthens whichever edge it has on hover.',
    },
    headerDivider: {
      type: 'boolean',
      description:
        'Draw a divider rule under the header. Off by default: the header is separated from the body\nby its surface alone, and a divider is opt-in.',
    },
    tone: {
      enum: ['default', 'danger'],
      description:
        'Container risk treatment. `danger` renders a danger-zone surface for high-risk settings or destructive actions.',
    },
    bodyTone: {
      enum: ['default', 'muted'],
      description: 'Body surface treatment. `muted` renders a grey/inset body region.',
    },
    footerTone: {
      enum: ['default', 'muted'],
      description: 'Footer surface treatment. `muted` renders a grey/inset footer region.',
    },
    headerTone: {
      enum: ['default', 'muted'],
      description:
        'Header surface treatment. `muted` renders a grey/inset header region, for a card whose title row reads as a band over its rows.',
    },
    edgeToEdgeOnMobile: {
      type: 'boolean',
      description: 'Remove side borders/radius and bleed to the viewport edge on narrow screens.',
    },
    padding: {
      enum: ['none', 'default'],
      description:
        'Body padding. `none` leaves header and footer padding intact while making body content flush with the card edges.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Basic card with no generated header.',
      },
      {
        name: 'footer',
        reason: 'function-or-snippet',
      },
      {
        name: 'header',
        reason: 'function-or-snippet',
        description: 'Card with a custom header snippet — full control over header content.',
      },
      {
        name: 'onclick',
        reason: 'function-or-snippet',
        description: 'Click handler that makes the entire card a button.',
      },
      {
        name: 'type',
        reason: 'unknown-shape',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
