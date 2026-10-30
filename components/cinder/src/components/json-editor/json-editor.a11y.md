# JsonEditor accessibility

JsonEditor loads a CodeMirror 6 editor the first time one mounts. Until it loads, on the server, and wherever it fails to load, a native `<textarea>` is the whole editor, so the field is always usable and always posts with its form.

Once the editor mounts, the textarea stays in the form but is hidden from the page and from assistive technology, and the CodeMirror editable area takes its place. That area is a `role="textbox"` with `aria-multiline="true"`, labelled by the visible label through `aria-labelledby`, and described by the description and the parse feedback through `aria-describedby`. A click on the label moves focus into the editor. A required field sets `aria-required`, and a disabled field sets `aria-disabled` and refuses edits.

Invalid JSON and external errors set `aria-invalid="true"` on the editable area and on the textarea, and the feedback line uses an alert role. Valid parse feedback uses a status role. The inline error underline and the lint glyph in the gutter are visual duplicates of that announced feedback, and they are not the only signal.

An empty optional field is valid. It announces nothing, shows the placeholder "Not set", and has neither an error nor a lint glyph. An empty required field still reports "Enter valid JSON."

Tab moves focus out of the editor and is never repurposed for indentation, so keyboard users cannot become trapped. The editor adds these keys without taking any of the browser's own:

- `Shift+Alt+F` (and `Option+Shift+F` on macOS): format the document as indented JSON. The visible Format button does the same and is disabled for empty or invalid JSON.
- `Ctrl+Space`: open completions when a `schema` is provided. `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` then move through, accept, and dismiss them.
- `Ctrl+Shift+[` and `Ctrl+Shift+]`: fold and unfold the block at the cursor. The fold gutter markers are also clickable.

Bracket matching and line numbers are visual aids and carry no information that is missing from the text. Syntax colors come from the Cinder status tokens, never from color alone: strings keep their quotes, and a parse error is announced as text.

Keep the label specific to the payload being edited. The placeholder is not a replacement for the label.
