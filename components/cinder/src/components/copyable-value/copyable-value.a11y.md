# CopyableValue design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: CopyButton, CodeBlock, Kbd.
- Why this component exists: A value and its copy button drawn as two parts wrap apart on a narrow screen, so the button sits alone on a row while the value breaks above it. The value and its control wrap together, with the control on the value's last line.
- Findings and resolutions: The value breaks after its slashes, colons, question marks, ampersands and equals signs, after a dot only when a part is longer than the place, and anywhere, including mid-word, only when a piece is; each part is a box with no text added, so the value reads and copies whole. The control is the existing CopyButton drawn quiet and bare, as CodeBlock draws its copy button, so its tooltip, confirmation and 44px hit region on a coarse pointer are unchanged.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No. The value is static text and the control is an ordinary CopyButton.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable. Only the copy control is focusable, and focus stays on it after a copy.

### Keyboard matrix

| Key or gesture | Context      | Expected behavior                          |
| -------------- | ------------ | ------------------------------------------ |
| Tab            | Copy control | Moves focus to the control.                |
| Enter, Space   | Copy control | Copies the value, as a native button does. |

### Assistive-technology announcements

The value reads as text. The control is named by `label` ("Copy to clipboard" unless the page says what is copied) and announces `copiedLabel` politely once the copy succeeds.

## Touch targets

Under a coarse pointer the copy control keeps CopyButton's 44px hit region.

## Forced colors

The value uses the system text colour and the control CopyButton's forced-colors styles.
