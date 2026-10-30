import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'The code to render.',
    },
    language: {
      type: 'string',
      description:
        'Optional language label rendered above the code (there is no header bar); also selects the grammar for highlighting.',
    },
    highlight: {
      type: 'boolean',
      description:
        'Whether to highlight. Defaults to `true` whenever `language` is set and a\nhighlighter resolves from the `highlighter` prop or from context.\n\n`highlight={false}` is an absolute off switch: it disables ALL\nhighlighting — including an explicit `highlighter` prop and a context\nhighlighter. The block renders the escaped plain `<pre><code>` fallback\nwhile keeping the `language` label. When highlighting is enabled,\nclient-side colorization may appear after first paint, but the block keeps\nstable layout metrics.',
    },
    copyable: {
      type: 'boolean',
      description:
        'When true, render an icon-only copy button above the code. The block has no header bar or frame.',
    },
    languageLabelVisible: {
      type: 'boolean',
      description:
        'Whether to render the language label above the code. Default `true`.\nPass `false` to keep `language`-driven highlighting without the visible\nlabel; with `copyable` also unset, nothing renders above the code.',
    },
    scrollFadeVisible: {
      type: 'boolean',
      description:
        'Show a scroll-driven fade on the horizontal (inline) edges of the code\nviewport as a long line overflows — signals "this line continues" rather\nthan dimming a wrapped block. Opt-in and presentation-only. The gradient\nterminates at partial opacity (not fully opaque) so a half-covered glyph\nstill reads as a glyph, not as a hard cutoff. Defaults to `false`.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-code-block`.',
    },
  },
  additionalProperties: false,
  required: ['code'],
  metadata: {
    unsupportedProps: [
      {
        name: 'highlighter',
        reason: 'function-or-snippet',
        description:
          'Highlighter for this instance. Receives `(code, language)` and returns an\nHTML string (sync or async). Takes precedence over a highlighter an\nancestor published through `setCodeHighlighterContext`; with neither, the\nblock renders unhighlighted.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
