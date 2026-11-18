import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Name of the hidden serialized output field. Defaults to `value`.',
    },
    jsonEditable: {
      type: 'boolean',
      description:
        'Whether a large form offers its own Edit as JSON panel. Defaults to `true`; set `false` when\nthe host already provides a JSON entry point for the same payload, so the page does not show\ntwo. Find a field and the other large-form affordances are unaffected.',
    },
    submitLabel: {
      type: 'string',
      description: 'Label for the built-in submit button. Defaults to `Submit`.',
    },
    variant: {
      enum: ['default', 'input', 'setting-rows'],
      description:
        'How the fields are drawn. `default` is the plain form. `input` is the Input block of a page\nthat runs or schedules something: short fields share a row two at a time (a switch, an\narray, a group or a JSON field takes the whole row), a boolean is a switch with its\ndescription beside it, and an array of objects is one JSON editor whose status line counts\nthe items. `setting-rows` draws each top-level property as one Settings row (`SettingRow`):\nthe label, the key and the description at the start, the control at the inline end, and a\nhairline between rows. A property whose control does not fit a column (an object, an array of\nobjects, a JSON field) is drawn under its row, full width and with no box of its own. The\nrows stack below a container width. A large form keeps the same rows: no Find a field, no\nEdit as JSON, no reordering.',
      default: 'default',
    },
    disabled: {
      type: 'boolean',
      description:
        'Whether every control is disabled, such as a form the host locks. The form is also disabled\nwhile it validates a submit. Defaults to `false`.',
    },
    submitVisible: {
      type: 'boolean',
      description:
        "Whether the form draws its own submit button. Set `false` when the host submits the form from\na button elsewhere on the page, such as a footer, whose `form` attribute names this form's\n`id`. Without the built-in button a form with several fields does not submit on Enter. Defaults to `true`.",
    },
    hosted: {
      type: 'boolean',
      description:
        'Whether the form is drawn inside another surface, such as a card or a page\'s own form. A hosted\nform is a `div` with `role="group"` and no `<form>` of its own, which a `<form>` in a `<form>`\nwould be, so it never submits, draws no submit button and offers no Edit as JSON panel. A group\ninside it is a legend line with its fields indented and no border, and the items of an array\nare told apart by a hairline instead of a dashed box, so the host\'s own border is the only box.\nRead the value through `onDraftChange`. Defaults to `false`.',
    },
    readOnly: {
      type: 'boolean',
      description:
        'Draws every field as a label and its value, with no control, no submit button and no Edit\nas JSON: a form the person can read and not change, such as a default hook\'s configuration. A\nsecret field shows its key in monospace beside a Set or Missing dot, and a `writeOnly` field\nshows "Hidden". Defaults to `false`.',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-schema-form`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'issues',
        reason: 'unknown-shape',
        description:
          'Problems the host found with a value this form submitted, such as a server-side validation\nrefusal. Each one is shown on the field its `path` names, as a built-in validation message is,\nand cleared when that field is edited. Pass a new array to show a new set.',
      },
      {
        name: 'onDraftChange',
        reason: 'function-or-snippet',
        description:
          'Called after each edit with the complete current draft, before schema validation.\nThe draft can be schema-invalid and does not change the seed-only `value` contract.\nIn-progress numeric editors and temporarily unparseable JSON fields are reported as\ntheir current raw text until the value commits or parses successfully.',
      },
      {
        name: 'onSubmit',
        reason: 'function-or-snippet',
        description: 'Called after validation passes with the schema-conformant output value.',
      },
      {
        name: 'schema',
        reason: 'unknown-shape',
        required: true,
        description: 'JSON Schema object used to render and validate the form.',
      },
      {
        name: 'secrets',
        reason: 'unknown-shape',
        description:
          'The saved secret keys a field marked `secret: true` offers, with the words and actions around\nit. A schema string marked `secret: true` is drawn as a Select of keys (never a text input) and\nits value is `{ "$secret": key }`. Without this prop such a field has no key to choose.',
      },
      {
        name: 'value',
        reason: 'unknown-shape',
        description:
          'Initial form value. Missing fields are seeded from the schema where possible.\n\n**Seed-only — value changes do not reset form state.** After mount the\nconsumer owns the form state. Changing `value` with the same `schema` does\nNOT reset the form (formValue, errors, rawDrafts). Only changing `schema`\ncauses a remount and resets form state. This is intentional: the form is an\nediting surface and resetting it on every external value change would\nsilently discard in-progress user edits.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
