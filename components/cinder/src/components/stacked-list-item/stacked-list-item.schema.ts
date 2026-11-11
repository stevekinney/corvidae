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
    leadingTone: {
      enum: ['neutral', 'info', 'success', 'warning', 'danger'],
      description:
        'Draws `leading` as a 32px rounded glyph tile tinted with this tone, one glyph per kind (the\nneeds-attention rows on Health use `warning`). The glyph is decoration, so give the tile no\naccessible name of its own.',
    },
    lines: {
      type: 'boolean',
      description:
        'Draws the two-line layout (bold title, one-line muted description or meta, a trailing region\ncentred beside both lines) for a row that has no status, time or details to trigger it. A row\nwith a `leadingTone` tile and `actions` is the usual case.',
    },
    selected: {
      type: 'boolean',
      description:
        "Marks the row as the one open in the detail beside the list. It takes an accent tint, which\nstays when the pointer is over it, and sets `aria-current` on the row's link (or on the row\nwhen it is not a link).",
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
    metaTooltip: {
      type: 'string',
      description:
        'Line two as text, shown as a tooltip over line two, which ends in an ellipsis when it is long.\nSet it to the same text the `meta` (or `description`) snippet renders.',
    },
    wrapMeta: {
      type: 'boolean',
      description:
        'Lets line two wrap onto more lines instead of ending in an ellipsis, so a control in it (a "View\npayload" link after a sentence about why a task failed) is never cut off and can always be\npressed. Default `false`.',
    },
    error: {
      type: 'string',
      description:
        'A row whose own details failed to load: line two says this message beside a warning glyph, in\nthe danger text colour, in place of `meta`, and the rest of the list stays live (there is no\nbanner and no full-page error). Pass `onRetryClick` for the secondary "Try again" button that\nbelongs to the row. A row with an `error` is not a link.',
    },
    retryLabel: {
      type: 'string',
      description: "Text of the error's retry button. Default `Try again`.",
    },
    actionsLabel: {
      type: 'string',
      description:
        'Accessible name of the phone menu button that holds `actions`. Default `More actions`.',
    },
    phoneActions: {
      enum: ['menu', 'buttons'],
      description:
        "What `actions` become on a phone: one menu button (`'menu'`, the default) or full-width\nbuttons stacked under the row's text (`'buttons'`), each a 44px target under a coarse pointer.",
    },
    groupLayout: {
      enum: ['row', 'band'],
      description: 'How a group row is drawn. Default `row`.',
    },
    tone: {
      enum: ['neutral', 'warning'],
      description:
        'The tint of a group row. Default `neutral`, the inset tint every group row has; `warning` is\nthe amber band of the missed runs.',
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
        name: 'detail',
        reason: 'function-or-snippet',
        description:
          "A third line under line two that wraps instead of ending in an ellipsis, so nothing on it is\never cut. A schedule row on a phone puts the reason it won't run first and the cadence last\non it; the cadence is the part a narrow screen can lose, so it is the last thing the line\nsays. It starts under the title, and is not drawn on a row with `details`.",
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
          'Line two: muted metadata, kind first, then agent, then detail, joined by commas. It starts\nunder the title (not under the status) and ends in an ellipsis rather than wrapping. A line\nthat must carry a control (an error with its own "Try again") may put one in.',
      },
      {
        name: 'onRetryClick',
        reason: 'function-or-snippet',
        description:
          'Called when the row\'s "Try again" button is chosen. Without it the error shows no button.',
      },
      {
        name: 'status',
        reason: 'function-or-snippet',
        description:
          "The row's status: a `StatusDot` with its word. It leads the row in a fixed 128px column that\nevery list on every page shares, so titles start at one x position down the list; on a phone\nit moves to line two, before the meta. The dot and word sit on the first line of the title.\nThe column is optional: a row with no `status` (and no `statusColumn`) reserves none. A dot\nwith its word is the documented row status; a tinted Badge or pill is not.",
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
