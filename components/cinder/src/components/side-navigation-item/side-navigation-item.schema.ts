import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    href: {
      type: 'string',
      description:
        'Destination URL. Providing this prop renders the item as an `<a>` element instead of a `<button>`.',
    },
    active: {
      type: 'boolean',
      description:
        'Marks this item as the currently active destination; emits `aria-current` and applies active visual styling.',
    },
    disabled: {
      type: 'boolean',
      description:
        'Prevents interaction: removes the item from the tab order, blocks clicks, and applies disabled visual styling.',
    },
    current: {
      enum: ['page', 'step', 'location', 'date', 'time', 'true'],
      description:
        "The `aria-current` token emitted while `active` is true. Defaults to `'page'`,\nwhich is correct for navigation bars and breadcrumb-adjacent links. Use\n`'true'` (or another standard token such as `'step'` / `'location'`) for\nsection/view switchers, where `'page'` would mislabel the current section as\nthe current page in the browsing context.",
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-navigation-item` root element.',
    },
    label: {
      type: 'string',
      description:
        'The row\'s name as plain text ("Health", "Reviews"). It names the row when a count is\npresent ("Health, 3 need attention") and is the first part of the tooltip\n("Reviews, 2 need you"). Without it the row has no composed name and no tooltip.',
    },
    count: {
      type: 'number',
      description:
        'A count of things that want attention. Zero, a negative number and `undefined` show nothing.\nShown as a pill beside the label (or on the icon when collapsed) unless `dot` is set, and\nalways part of the accessible name when `label` is given.',
    },
    countLabel: {
      type: 'string',
      description:
        'The words that follow the count in the accessible name and tooltip: "need you" gives\n"Reviews, 2 need you". The pill\'s own name is the count plus these words.',
    },
    emptyLabel: {
      type: 'string',
      description:
        'The words that follow the label in the accessible name and tooltip when `count` is zero or\nabsent: "nothing needs attention" gives "Health, nothing needs attention". Without it a row\nwith no count is named by its label alone.',
    },
    countTone: {
      enum: ['neutral', 'success', 'warning', 'danger', 'info', 'accent'],
      description:
        "Tone of the count pill. Defaults to `'warning'`, the amber of a count that needs attention.",
    },
    dot: {
      enum: [
        'neutral',
        'success',
        'warning',
        'danger',
        'info',
        'accent',
        'online',
        'offline',
        'pending',
      ],
      description:
        'A status dot shown beside the label (or on the icon when collapsed) in place of the numeric\npill, for a row whose state is a signal and not a figure. The dot is hidden from assistive\ntechnology, so a row that sets it should also set `count` and `countLabel`, which carry\nthe meaning in the accessible name.',
    },
    collapsed: {
      type: 'boolean',
      description:
        "Whether the row is drawn as an icon-rail entry. Defaults to the enclosing `Sidebar`'s collapsed\nstate, so a row follows its sidebar without being told.",
    },
    listItemClass: {
      type: 'string',
      description: 'Class merged onto the outer <li>.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description:
          "The row's label, rendered after `icon`. When `icon` is also given, a collapsed row (an icon\nrail) hides this label visually and keeps it in the accessible name.",
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
        description:
          "The row's icon. Giving it lets the row collapse to an icon rail: the icon stays, the label\nstays in the accessible name, and the count or dot moves onto the icon's corner. The wrapper\nis `aria-hidden`, so the icon is decoration and the label names the row.",
      },
      {
        name: 'onclick',
        reason: 'function-or-snippet',
        description:
          'Optional click handler called for the rendered `<a>` element. Useful for\nintercepting plain left-clicks for SPA navigation while letting modified\nclicks (cmd/ctrl/shift/alt or middle-click) fall through to native browser\nbehavior. Disabled-state preventDefault still applies.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
