# WeekSchedule design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: ScheduleBuilder, DescriptionList, Calendar.
- Why this component exists: A seven-column week grid broke a range such as "2:00–8:00 pm" mid-range. One row per day keeps each range whole and gives the description room.
- Findings and resolutions: A live window is an inverted "On now" pill, not a colour. Today is a surface and `aria-current="date"`. The range is `nowrap` and a window past midnight says "next day".

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the schedule is a static ordered list with no interaction.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable; nothing in the schedule is focusable.

### Keyboard matrix

| Key or gesture | Context | Expected behavior                       |
| -------------- | ------- | --------------------------------------- |
| Not applicable | Static  | The schedule takes no keyboard actions. |

### Assistive-technology announcements

The list reads its optional name, then each day, its range and its description. Today's row is announced as the current date. The pill reads as text, so liveness is not colour alone.

## Forced colors

Today's row and the live pill gain a `CanvasText` border, because their fills are not drawn.
