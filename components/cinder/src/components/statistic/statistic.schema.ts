import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: 'Short label describing the metric, e.g. "Monthly Revenue".',
    },
    value: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'number',
        },
      ],
      description: 'The statistic. Strings rendered verbatim; numbers formatted via formatNumber.',
    },
    attention: {
      type: 'boolean',
      description:
        'Draws an amber attention dot before the label. Set it only when the value is a non-zero bad count (such as missed runs or items waiting on you), never on a zero or a healthy count. The dot is decorative: the label wording carries the meaning.',
    },
    theme: {
      type: 'object',
      properties: {
        foreground: {
          type: 'string',
        },
        muted: {
          type: 'string',
        },
        grid: {
          type: 'string',
        },
        background: {
          type: 'string',
        },
        palette: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
      description:
        'Partial visual theme override. Omitted fields inherit the surrounding application.',
    },
    valueLocale: {
      type: 'string',
      description:
        'Locale forwarded to formatNumber. Defaults to the nearest LocaleProvider locale, then en-US.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-statistic`.',
    },
    style: {
      type: 'string',
      description: 'Inline style string applied to the `.cinder-statistic` root.',
    },
  },
  additionalProperties: false,
  required: ['label', 'value'],
  metadata: {
    unsupportedProps: [
      {
        name: 'change',
        reason: 'unknown-shape',
        description: 'Optional change indicator with direction and accessible wording.',
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
        description: 'Optional leading icon snippet (decorative — wrapper is aria-hidden).',
      },
      {
        name: 'valueFormatOptions',
        reason: 'unknown-shape',
        description: 'Intl.NumberFormat options applied only when `value` is a number.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
