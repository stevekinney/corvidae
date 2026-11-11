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
    variant: {
      enum: ['horizontal', 'mobile', 'vertical'],
      description:
        "Controls item geometry. Emitted as `data-variant`. Default `'horizontal'`.\n\n- `'horizontal'`: top-rounded radius, accent bottom-border active indicator.\n  Used inside `NavigationBar` and similar horizontal tab-bar contexts.\n- `'mobile'`: stacked full-width layout when an owning navigation surface\n  enters its narrow container mode.\n- `'vertical'`: a 30px rounded row (44px under a coarse pointer), a neutral hover tint, and a neutral tint (the ink at about 7%) with default text and semibold weight as the active indicator.\n  Used inside `SideNavigation` (set automatically by `SideNavigationItem`) or\n  standalone sidebar footers where flush sidebar edges are required.",
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
        description:
          "The item's icon, drawn before the label in every placement: beside it in a horizontal tab\nor a vertical row, above it in a bottom `NavigationBar` tab. The wrapper is `aria-hidden`,\nso the icon is decoration and the label names the item. The label is wrapped in a\n`[data-cinder-navigation-label]` element, so a bottom bar's `labelsVisible` can hide it\nvisually and keep it in the accessibility tree. Without an icon the children render as they\nare.",
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
