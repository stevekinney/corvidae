# SchemaForm Accessibility

## Roles and Names

- The component renders a native `<form>` element and native text, number, select, and textarea controls wherever the schema shape is inspectable.
- Every generated field receives a visible label. Required fields include a visual `*` marker; schema validation still owns the actual validity contract.
- Generated descriptions and errors are connected to their controls with `aria-describedby`.
- Failed validation sets `aria-invalid="true"` on the invalid field. Boolean fields render as `button role="switch"` with `aria-checked` and use `aria-required="true"` when the schema marks them required.

## Control Shapes

- Enum arrays render as a `fieldset` whose legend is the field label; each option is a toggle button with `aria-pressed`.
- String arrays render a tag input named by the field label; committed tags can be removed with the keyboard like any tag input.
- Records render a key/value row list. Each input is named `Key` or `Value`, and the add and remove buttons carry the field label so several records on one page stay distinguishable.
- A choice renders a `radiogroup` with one radio per alternative, in a `group` named by the field label (a `div`, not a `fieldset`: it has no border). Each radio is named in words (`Keep all`, `Off`), never by a JSON type. A root choice draws no visible title, and keeps the group's name.
- A yes or no that may be unset is a `radiogroup` of three radios, `Not set`, `Yes` and `No`, named by the field label; `Not set` is the `null`.
- An object that may be unset is a `radiogroup` of `Not set` and `Set`, and its fields are in the page only once it is set.
- A list that may be unset says "Not set" while it is `null`, and otherwise has one `Clear <label>` button, which returns it there.
- An empty number that may be `null` has a placeholder, "Not set" or the field's own short description, so an emptied field reads as set to nothing.
- A millisecond field renders a labelled number input and a select named `<label> unit`.

## Setting Rows

- The `setting-rows` variant draws each top-level property as a `SettingRow`: the visible label is a `<label>` for the row's control, the key is outside the label so it is not part of the control's name, and the description and error are connected to the control with `aria-describedby`. A group of one short field is one row: the row is a `role="group"` named by the group's title, and the control keeps the field's own label as its name (drawn for assistive technology only).
- A property drawn under its row (an object, an array of objects) keeps its label and description on the row; the nested fields and the JSON editor carry their own names. No group has a border, and none is a `fieldset` unless the schema nests a group inside another.
- The row stacks the control under the label when its container is narrow; the reading and focus order do not change.

## Large Forms

- Collapsible groups are disclosure buttons with `aria-expanded`; the closed-group summary is part of the button's name.
- Find a field is a search input. Enter does not submit the form from it, and a result with no matches is announced through a `status` region.
- Edit as JSON is a button with `aria-expanded` that reveals a labelled JSON textarea; a refused paste is reported as that field's error.

## Keyboard Interactions

| Key         | Behaviour                                                           |
| ----------- | ------------------------------------------------------------------- |
| Tab         | Moves through generated controls and buttons in DOM order.          |
| Shift + Tab | Moves backward through generated controls and buttons.              |
| Enter       | Submits the form from text-like controls.                           |
| Space/Enter | Toggles generated switch controls when the switch itself has focus. |

Array add/remove controls are native buttons and use their standard keyboard behavior.

## Validation and Focus

On failed submit, the form prevents native submission, renders field-level errors, and moves focus to the first invalid control or error message. The error text has `aria-live="polite"` so newly rendered messages are announced without interrupting current speech.

On successful submit, the hidden serialized output field is updated before the callback runs. Consumers that read `FormData` can parse the same value with `readSchemaFormData`.

## Raw JSON Fallback

Unknown or unsupported schema nodes render as a labelled JSON editor (a Cinder `JsonEditor`, the same in every variant, with a textarea under it) containing JSON. Invalid JSON is reported as a field error and blocks submission. This preserves data instead of silently dropping fields the renderer cannot safely model.
