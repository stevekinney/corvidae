import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    cancelLabel: {
      type: 'string',
      description: 'Label for the cancel button, which ALWAYS renders.',
      default: 'Cancel',
    },
    open: {
      type: 'boolean',
      description: 'Controls visibility. Bindable.',
    },
    title: {
      type: 'string',
      description: 'Modal title; passed through to <Modal>.',
    },
    confirmLabel: {
      type: 'string',
      description:
        'Confirm button label. Required — no default. Name the action being confirmed:\n- Destructive: "Delete", "Discard changes", "Remove from organization".\n- Non-destructive: "Save", "Continue", "Publish".\nNever use "OK" or "Confirm" in production — they don\'t describe the action.',
    },
    destructive: {
      type: 'boolean',
      description:
        'When true, the confirm button uses variant="danger". The cancel button still\nreceives default focus regardless — color is never the sole destructive signal.',
    },
    typeToConfirm: {
      type: 'string',
      description:
        'When set, renders a labelled text input and disables the confirm button until the\ntrimmed input matches this value case-insensitively.',
    },
    typeToConfirmLabel: {
      type: 'string',
      description:
        'Visible label for the typed-confirmation input. Defaults to `Type "<value>" to confirm`.',
    },
    busy: {
      type: 'boolean',
      description:
        'True while the confirmed work is in flight. The confirm button shows `busyLabel` and a spinner\nand ignores presses (it stays focusable), Cancel is inert, the typed field is read-only, and\nthe dialog cannot be dismissed (Escape, the backdrop and the close button do nothing) until\nthe work answers. Pair it with `closeOnConfirm={false}`, so the dialog stays open to show the\nanswer.',
      default: false,
    },
    busyLabel: {
      type: 'string',
      description:
        'Confirm button label while `busy`, such as "Restoring…" or "Deleting…". Defaults to\n`confirmLabel`, so the words stay put and only the spinner shows.',
    },
    errorTitle: {
      type: 'string',
      description:
        'Bold lead sentence of the failure, such as "Couldn’t delete the agent.", set before `error`.\nShown only with `error`.',
    },
    error: {
      type: 'string',
      description:
        'Why the confirmed work failed, in a danger callout between the body and the actions that is\nannounced as it appears: "Nothing was deleted." The dialog stays open, the typed text stays,\nand the confirm button stays armed under its own label, so pressing it again is the retry.\nClear it to hide the callout.',
    },
    closeOnConfirm: {
      type: 'boolean',
      description:
        'Whether the dialog closes itself when the confirm button is pressed. Set `false` when the\nconfirmed work can fail and the page needs the dialog to stay open to show it: the page then\ncloses the dialog with `open = false` once the work succeeds.',
      default: true,
    },
    sheetBelow: {
      anyOf: [
        {
          type: 'string',
        },
        {
          const: false,
        },
      ],
      description:
        'Viewport width below which the dialog is a bottom sheet: a grabber, the confirmation first and\nCancel under it, both full width at 44px, with Cancel keeping initial focus. A CSS length such\nas `"640px"`, or `false` for the centred dialog at every width.',
      default: '640px',
    },
    class: {
      type: 'string',
      description:
        'Optional extra class on the underlying <Modal>. Destructured as `class: className` per repo convention.',
    },
  },
  additionalProperties: false,
  required: ['confirmLabel', 'open', 'title'],
  metadata: {
    unsupportedProps: [
      {
        name: 'confirmIcon',
        reason: 'function-or-snippet',
        description:
          'Glyph at the start of the confirm button, such as a restart, stop or trash icon. Decorative:\nthe label names the action.',
      },
      {
        name: 'description',
        reason: 'function-or-snippet',
        description:
          'Optional body description — a short sentence or two. Rendered as a single <p> and wired\nto aria-describedby. A string is plain text; a snippet may add phrasing content inside the\nsentence, such as a key in `<code>`. Anything bigger than a sentence (a list, a code block, a\ncheckbox) goes in `options`, below it. Screen readers announce aria-describedby targets as one\ncontinuous run, so keep the description short either way.',
      },
      {
        name: 'onCancel',
        reason: 'function-or-snippet',
        description:
          "Called when the user cancels (cancel button, Escape, or backdrop per the dialog's policy).",
      },
      {
        name: 'onConfirm',
        reason: 'function-or-snippet',
        required: true,
        description:
          'Fired when the user activates the confirm button. Required. The component closes itself\nafter, unless `closeOnConfirm` is `false`.',
      },
      {
        name: 'onExitComplete',
        reason: 'function-or-snippet',
        description: "Fired once the underlying modal's exit transition has completed.",
      },
      {
        name: 'options',
        reason: 'function-or-snippet',
        description:
          'Content rendered below the description and above the typed confirmation: a checkbox that\nchanges what the confirmation does, or the exact command about to run in a code block. The\ndescription says what the dialog does; the options say what each choice does. Keep the\ndescription short, and keep controls here labelled.',
      },
      {
        name: 'triggerRef',
        reason: 'unknown-shape',
        description: 'Forwarded to <Modal>; focus is restored here on close.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
