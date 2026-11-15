# JsonEditor accessibility

JsonEditor loads a CodeMirror 6 editor the first time one mounts. Until it loads, on the server, and wherever it fails to load, a native `<textarea>` is the whole editor, so the field is always usable and always posts with its form.

Once the editor mounts, the textarea stays in the form but is hidden from the page and from assistive technology, and the CodeMirror editable area takes its place. That area is a `role="textbox"` with `aria-multiline="true"`, labelled by the visible label through `aria-labelledby`, and described by the description and the parse feedback through `aria-describedby`. A click on the label moves focus into the editor. A required field sets `aria-required` and keeps the native `required` constraint on the hidden textarea, so an empty required field still blocks form submission and the invalid-field focus goes to the visible editor. A disabled field sets `aria-disabled` and refuses edits. A read-only field sets `aria-readonly`: it stays focusable and selectable and posts with its form, but it cannot be edited or formatted.

Validity is announced from the status in the frame's top corner, a polite live region that is always mounted so a change is read out: "Valid JSON", "Line 2: expected a comma", "Empty", or "Read only". It is part of the editor's description. When the source does not parse, the status is a button that moves the caret to the marked line, so a keyboard user reaches the problem without scrolling. Invalid JSON and external errors set `aria-invalid="true"` on the editable area and on the textarea. An external `error` renders under the field as an alert with a glyph. The tinted rectangle and its bar, the red line number, and the message under a marked line are visual duplicates of the announced status and are never the only signal: the line number is in the status text, and the status does not rely on color.

An empty optional field is valid. It reads "Empty", shows the muted example in the body, and has no mark. An empty required field reports "Enter valid JSON".

Tab moves focus out of the editor and is never repurposed for indentation, so keyboard users cannot become trapped. The editor adds these keys without taking any of the browser's own:

- `Shift+Alt+F` (and `Option+Shift+F` on macOS): format the document as indented JSON. The visible Format button does the same and is disabled for empty or invalid JSON; a read-only editor has no Format button.
- `Ctrl+Space`: open completions when a `schema` is provided. `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` then move through, accept, and dismiss them.
- `Ctrl+Shift+[` and `Ctrl+Shift+]`: fold and unfold the block at the cursor. The fold gutter markers are also clickable.

The quiet focus ring wraps the whole frame while the editor has focus, and under forced colors it becomes a system outline. Bracket matching and line numbers are visual aids and carry no information that is missing from the text. Syntax colors come from the Cinder status tokens, never from color alone: strings keep their quotes, and a parse error is announced as text.

Keep the label specific to the payload being edited. The placeholder is not a replacement for the label.
