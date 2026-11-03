import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    density: {
      enum: ['comfortable', 'condensed'],
      description:
        "Density token surfaced as `data-cinder-density`. When omitted, inherits the\nenclosing DataList's list-level `density` (if any), then falls back to\n`comfortable`. An explicit value here always overrides the list default.",
    },
    statusColumn: {
      type: 'boolean',
      description:
        "Keep the status column's width even when this row has no `status` (a workflow or an agent\nwith nothing to report), so titles line up. Inherits the enclosing DataList's\n`statusColumn`. Setting it on a row that has a `status` has no effect.",
    },
    statusPlacement: {
      enum: ['leading', 'line-two'],
      description: 'Where the status sits. Default `leading`.',
    },
    titleLines: {
      enum: [1, 2],
      description:
        "How many lines the title may take before an ellipsis. Default `2`; the status and the time\nstay beside the first line, and the full title is the row's `tooltip`. A title never grows a\nrow without bound, and an unbroken value (an identifier) wraps anywhere.",
    },
    tooltip: {
      type: 'string',
      description:
        "The full title as text, shown as the row's tooltip when the title is clamped. Set it to the\nsame text the `title` snippet renders.",
    },
    actionsLabel: {
      type: 'string',
      description:
        'Accessible name of the phone menu button that holds `actions`. Default `More actions`.',
    },
    expanded: {
      type: 'boolean',
      description: "Whether a group row's `details` are showing. Bindable; default `false`.",
    },
    expandLabel: {
      type: 'string',
      description: 'Text of the button that opens a group row. Default `Show`.',
    },
    collapseLabel: {
      type: 'string',
      description: 'Text of the button that closes a group row. Default `Hide`.',
    },
    class: {
      type: 'string',
      description: 'Merged with `cinder-stacked-list-item`.',
    },
    href: {
      type: 'string',
      description:
        'Destination URL that turns the `title` snippet into an `<a>` link. The link covers the whole\nrow, so the row is one target: hover tints the whole row and the keyboard focus ring wraps it.\nControls inside the row (`actions`, `trailing`, a button in `meta`) stay separately usable.',
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
        '`rel` attribute forwarded to the title anchor; `noopener noreferrer` is merged automatically when `target="_blank"`.',
    },
    hreflang: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'null',
        },
      ],
      description:
        '`hreflang` attribute forwarded to the title anchor, indicating the language of the linked resource.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'actions',
        reason: 'unknown-shape',
        description:
          'Text actions at the end of the row. On a tablet or desktop each is a secondary small button;\non a phone (below 640px) they collapse into one menu button with the same actions, which is a\n44px target under a coarse pointer.',
      },
      {
        name: 'description',
        reason: 'function-or-snippet',
        description: 'Secondary description below the title.',
      },
      {
        name: 'details',
        reason: 'function-or-snippet',
        description:
          'Turns the row into a collapsed group row (the missed runs on Runs): a "Show" / "Hide" button\nat the right of line one reveals this snippet beneath the row, aligned with the title. A\ngroup row is not a link.',
      },
      {
        name: 'leading',
        reason: 'function-or-snippet',
        description:
          'Leading visual (avatar, icon, status dot). With a status column it follows the column.',
      },
      {
        name: 'meta',
        reason: 'function-or-snippet',
        description:
          'Line two: muted metadata, kind first, then agent, then detail, joined by middots. It starts\nunder the title (not under the status) and ends in an ellipsis rather than wrapping. A line\nthat must carry a control (an error with its own "Try again") may put one in.',
      },
      {
        name: 'status',
        reason: 'function-or-snippet',
        description:
          "The row's status: a `StatusDot` with its word. It leads the row in a fixed 128px column that\nevery list on every page shares, so titles start at one x position down the list; on a phone\nit moves to line two, before the meta. The dot and word sit on the first line of the title.",
      },
      {
        name: 'target',
        reason: 'unknown-shape',
        description:
          'Browsing context for the title anchor (`_blank`, `_self`, `_parent`, `_top`, or a named frame).',
      },
      {
        name: 'time',
        reason: 'function-or-snippet',
        description:
          'The time, or the next run, at the right edge of line one, aligned to its top. Pass a\n`RelativeTime` or a plain string.',
      },
      {
        name: 'title',
        reason: 'function-or-snippet',
        required: true,
        description: 'Primary label. Required.',
      },
      {
        name: 'trailing',
        reason: 'function-or-snippet',
        description: 'Trailing region (chevron, action button, dropdown trigger).',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
