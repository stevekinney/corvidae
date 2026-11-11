import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    ariaLabel: {
      type: 'string',
      description:
        'Accessible name for the <nav> landmark. Required, non-empty, distinct from other navs on the page.',
    },
    class: {
      type: 'string',
      description: 'Additional CSS class merged with `.cinder-side-navigation`.',
    },
    style: {
      type: 'string',
      description: 'Inline style string applied to the `.cinder-side-navigation` root.',
    },
  },
  additionalProperties: false,
  required: ['ariaLabel'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Must be <li> elements containing NavigationItem and/or SideNavigationGroup.',
      },
      {
        name: 'brand',
        reason: 'function-or-snippet',
        description:
          "The product's name, mark or workspace switcher, drawn above the primary action and the list.\nWrap it as you like; the slot adds only the padding that aligns it with the rows.",
      },
      {
        name: 'primaryAction',
        reason: 'function-or-snippet',
        description:
          'The one action the product leads with ("Capture", "New chat"), drawn under `brand` and above\nthe list. Render a single `<a>` or `<button>`: it is drawn as a neutral, sidebar-wide control\nwith a leading accent "+", its label, and, for an element with `data-cinder-shortcut`, the\nshortcut glyph at the trailing edge as plain text with no key cap. It is never a full-width\naccent slab. Name the shortcut for assistive technology with `aria-keyshortcuts` on the\ncontrol, and mark the glyph `aria-hidden`.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
