import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Native id placed on the `<button>`; the rendered label uses `aria-labelledby` to name it (label id is derived as `${id}-label`).',
    },
    checked: {
      type: 'boolean',
      description: 'Whether the toggle is currently checked. Bindable — defaults to false.',
    },
    label: {
      type: 'string',
      description:
        'Visible label text. Always the accessible name, even when `labelVisible` is set. Required.',
    },
    disabled: {
      type: 'boolean',
      description: 'Prevents interaction when true. Sets `disabled` attribute.',
    },
    readonly: {
      type: 'boolean',
      description:
        'Shows the setting without letting a press change it, for a value that something else owns,\nsuch as a schedule defined in a file. The switch stays focusable, announces\n`aria-readonly="true"`, ignores a press on the track or the label, and still submits its value\nwith a native form (unlike `disabled`).',
      default: false,
    },
    description: {
      type: 'string',
      description:
        'Short visible text beside the label that describes the switch, such as the file that defines\nit ("Defined in workflows/release-notes.json"). It is wired into `aria-describedby`.',
    },
    descriptionVisible: {
      type: 'boolean',
      description:
        'Whether `description` is drawn. Set `false` for a description that only a screen reader needs,\nsuch as the consequence of flipping a switch whose reason the page already says in words: it\nstays wired into `aria-describedby` and is visually hidden.',
      default: true,
    },
    descriptionPlacement: {
      enum: ['inline', 'below'],
      description:
        'Where `description` sits. `inline` is on the label\'s line, for a few words ("Defined in\nworkflows/release-notes.json"). `below` stacks it under the label, with the switch beside both,\nfor a sentence that explains what the switch does.',
      default: 'inline',
    },
    mutating: {
      type: 'boolean',
      description:
        "Marks a switch that changes something. Inside a stale `<StaleRegion>` it goes inert:\n`aria-disabled`, still focusable, ignoring the press, and described by the region's reason.\nIt returns by itself when the region stops being stale.",
      default: false,
    },
    nameDetail: {
      type: 'string',
      description:
        'Words that follow the visible label in the accessible name only, such as the thing the switch\nbelongs to ("Daily summary schedule" makes the name "Active, Daily summary schedule"). The\nvisible label stays first, so the name keeps WCAG 2.5.3 (Label in Name). The name is then the\nswitch\'s `aria-label`, written as one string so every platform reads it alike.',
    },
    labelVisible: {
      type: 'boolean',
      description:
        'Whether the label is visibly rendered. Set `false` for icon-only or\ninline contexts — it stays the accessible name.',
      default: true,
    },
    name: {
      type: 'string',
      description:
        'Form field name. When set, a hidden checkbox mirrors `checked` so the toggle\nparticipates in native form submission. Omit for purely client-side toggles\n(no hidden input is rendered, so there is zero overhead).',
    },
    value: {
      type: 'string',
      description:
        "Value submitted for the hidden checkbox when `checked` and `name` is set.\nMirrors native checkbox semantics: the pair `name=value` is sent only while\nchecked. Defaults to `'on'`. Ignored when `name` is unset.",
    },
    form: {
      type: 'string',
      description:
        'Associates the hidden checkbox with a form by id, matching the native\n`form` attribute. Lets the toggle submit with a form it is not nested in.\nIgnored when `name` is unset.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-toggle` on the switch button.',
    },
  },
  additionalProperties: false,
  required: ['id', 'label'],
  metadata: {
    unsupportedProps: [
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description: 'Notify after the bindable value has been committed.',
      },
      {
        name: 'onValueChangeRequest',
        reason: 'function-or-snippet',
        description:
          'Intercept a proposed checked state before the bindable value is written. Return a replacement value to transform it.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
