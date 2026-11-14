import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    color: {
      enum: ['primary', 'inherit'],
      description:
        "Controls the link color.\n- `'primary'` — uses the accent/primary color token.\n- `'inherit'` — inherits the surrounding text color.",
      default: 'primary',
    },
    href: {
      type: 'string',
      description:
        'The URL the link points to. Optional ONLY because a `disabled` link renders a\n`<span>` with no href. For any enabled (non-disabled) link you must provide it —\nan `<a>` without `href` is not keyboard-focusable and is not exposed as a link to\nassistive technology, so an enabled Link without `href` is a bug, not a feature.',
    },
    underline: {
      enum: ['always', 'hover', 'none'],
      description:
        "Controls text-decoration behavior.\n- `'always'` — underline is always visible.\n- `'hover'` — underline appears on hover and focus (default).\n- `'none'` — underline is never shown.",
      default: 'hover',
    },
    variant: {
      enum: ['inline', 'more'],
      description:
        "The link's form.\n- `'inline'` — a link in running text, at the text's own size and weight.\n- `'more'` — a link out to the page that holds the rest, such as \"Open Reviews\" beside a\n  section's title or at the end of an empty row: small regular text with a chevron after it,\n  on one line, and a 44px hit area under a coarse pointer that takes no layout.",
      default: 'inline',
    },
    external: {
      type: 'boolean',
      description:
        'When true, automatically adds `target="_blank"` and merges `rel="noopener noreferrer"`\nwith any consumer-supplied `rel`. Consumer-supplied `target` is preserved if provided.',
      default: false,
    },
    disabled: {
      type: 'boolean',
      description:
        'When true, renders a `<span aria-disabled="true">` instead of `<a>`. The href is not\nemitted and pointer-events are disabled. Use to show a link that is contextually\nunavailable without removing it from the visual layout.',
      default: false,
    },
    rel: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'null',
        },
      ],
      description:
        'Forwarded to the rendered `<a>`. `"noopener noreferrer"` is merged in whenever the link\nopens in a new tab — `external` is true OR the resolved target is `"_blank"`\n(case-insensitive) — and the whole value is de-duplicated case-insensitively.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-link`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'The link text or composed content. Required.',
      },
      {
        name: 'target',
        reason: 'unknown-shape',
        description:
          'Forwarded to the rendered `<a>`. `external` supplies `"_blank"` only when no target is given.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
