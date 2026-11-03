# DurationField design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: NumberInput, Select, TimeField.
- Why this component exists: Durations stored in milliseconds printed as raw numbers and asked people to count zeros. The number-plus-unit control existed only inside SchemaForm; settings pages need the same control, with the unit fixed beside the number when a setting always counts in one unit.
- Findings and resolutions: It composes NumberInput and Select rather than drawing its own input. The unit select gets its own form-field context so it never reads the id or error of an enclosing FormField or SettingRow.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the field is a number input and a native select side by side.
- Reviewer: Not applicable.
- Review outcome: No novel interaction review required.

### Focus management

Focus is never moved. Changing the unit keeps focus on the select and re-expresses the number in the new unit.

### Keyboard matrix

| Key or gesture       | Context         | Expected behavior                         |
| -------------------- | --------------- | ----------------------------------------- |
| Tab                  | The field       | Moves from the number to the unit select. |
| Arrow keys           | The unit select | Change the unit, as a native select does. |
| Arrow Up, Arrow Down | The number      | Step the number, as NumberInput does.     |

### Assistive-technology announcements

The number is named by `label` and described by `description` and `error`. The unit select is named "<label> unit". A fixed unit is text inside the number's frame, read with the number.

## Forced colors

Both controls use their own forced-colors styling.
