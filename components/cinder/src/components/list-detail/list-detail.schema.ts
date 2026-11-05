import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: 'Accessible name of the list region, for example "Chats".',
    },
    loading: {
      type: 'boolean',
      description:
        'Shows a placeholder in place of the rows and the open item while the records load: five list\nrows in the list pane and a block in the detail pane. Nothing shows for the first 300\nmilliseconds, so a fast load never flickers, and a slow one adds a "still loading" line after\nten seconds.',
      default: false,
    },
    loadingLabel: {
      type: 'string',
      description:
        'What the loading region announces, politely, once the placeholder appears: "Loading memories".',
      default: 'Loading',
    },
    selectedKey: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'null',
        },
      ],
      description:
        "Key of the open item, or `null` when none is open. Bindable. When it is `null` on mount, the\nitem named by the URL's search parameter opens.",
      default: null,
    },
    selectionParameter: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'null',
        },
      ],
      description:
        "Name of the search parameter that holds the open item's key. Pass `null` to keep the\nselection out of the URL.",
      default: 'selected',
    },
    storageKey: {
      type: 'string',
      description:
        "Storage key under which the divider width is remembered. Omit to not remember it. The key is\nthe caller's, so two ListDetails on one page do not share a width.",
    },
    pushBelow: {
      type: 'number',
      description:
        'Width in pixels of the component below which it shows one pane at a time: the list, then the\ndetail with a Back button. It is measured on the component, not the viewport.',
      default: 600,
    },
    stackBelow: {
      type: 'number',
      description:
        'Width in pixels of the component below which, down to `pushBelow`, the two panes are shown one\nabove the other, the detail under the list, instead of side by side. The default `0` never\nstacks them: the panes sit side by side until `pushBelow` and show one at a time under it.',
      default: 0,
    },
    flushDetail: {
      type: 'boolean',
      description:
        "Removes the detail pane's inner padding, for a detail view that lays out its own header, body\nand footer edge to edge (an open chat, a table, a code frame).",
      default: false,
    },
    defaultListWidth: {
      type: 'number',
      description: 'Width in pixels of the list pane before the divider is moved.',
      default: 280,
    },
    maximumListWidth: {
      type: 'number',
      description:
        'Widest width in pixels the divider can give the list pane, and the most a remembered or default\nwidth can be. Raise it for a list that is a table, whose columns need more than a list of rows.',
      default: 560,
    },
    backLabel: {
      type: 'string',
      description: 'Label of the Back button shown above the detail below `pushBelow`.',
      default: 'Back',
    },
    detailLabel: {
      type: 'string',
      description: 'Accessible name of the detail region.',
      default: 'Details',
    },
    emptyTitle: {
      type: 'string',
      description: 'Title of the default empty detail, used when `empty` is omitted.',
      default: 'Nothing selected',
    },
    emptyDescription: {
      type: 'string',
      description: 'Description of the default empty detail, used when `empty` is omitted.',
      default: 'Choose an item from the list to see it here.',
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-list-detail` root element.',
    },
  },
  additionalProperties: false,
  required: ['label'],
  metadata: {
    unsupportedProps: [
      {
        name: 'detail',
        reason: 'function-or-snippet',
        required: true,
        description: 'Detail renderer for the open item.',
      },
      {
        name: 'empty',
        reason: 'function-or-snippet',
        description:
          'Rendered in the detail pane while no item is open. A default message is shown when omitted.',
      },
      {
        name: 'groupBy',
        reason: 'function-or-snippet',
        description:
          "Groups consecutive items under a header band, such as a source or a day. Passed to the list's\n`DataList`, so a group is a nested list named by its header.",
      },
      {
        name: 'header',
        reason: 'function-or-snippet',
        description:
          "List header, above the rows: the title, the count, the create action, the search and the\nfilter. Put the title and the create action on their own row and the filter below at full\nwidth, so the action never reads as the filter's submit button.",
      },
      {
        name: 'items',
        reason: 'generic-type-parameter',
        required: true,
        description:
          'The records to list. Each is passed to `list` and, when selected, to `detail`.',
      },
      {
        name: 'key',
        reason: 'function-or-snippet',
        required: true,
        description:
          'Key extractor. The key identifies an item in the keyboard cursor, the selection, and the URL.',
      },
      {
        name: 'list',
        reason: 'function-or-snippet',
        description:
          'Row renderer, called once per item inside an `<li>` that ListDetail provides. Render a\n`SelectableRow` with `selected={row.selected}` and `selectedState="current"`; activating its\nprimary action opens the item. Omit it when `listBody` draws the rows.',
      },
      {
        name: 'listBody',
        reason: 'function-or-snippet',
        description:
          'Draws the whole list pane body itself, in place of the `<li>` rows, for a list that is a table.\nGive each row a `data-cinder-row-id` equal to its `key` (a `DataTable` does) so the J and K\ncursor finds it, and call `open` when a row is chosen. `list`, `groupBy` and `listEmpty` are\nignored while it is set.',
      },
      {
        name: 'listEmpty',
        reason: 'function-or-snippet',
        description: 'Rendered in the list when `items` is empty.',
      },
      {
        name: 'onSelectedKeyChange',
        reason: 'function-or-snippet',
        description:
          'Called with the new key when an item opens, and with `null` when the selection is cleared.',
      },
      {
        name: 'selectionLocation',
        reason: 'unknown-shape',
        description: 'Where the selection is read and written. Defaults to the address bar.',
      },
      {
        name: 'storage',
        reason: 'unknown-shape',
        description: 'Where the divider width is remembered. Defaults to `localStorage`.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
