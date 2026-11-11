# Text accessibility

## Pattern

Text styles a run of text. The `variant` picks the visual style and the matching default element, so `h1` to `h5` render real headings and `caption` and `body` render paragraphs. Use `as` when the document outline needs a different element than the visual style implies, such as a visually small `h2`.

Purpose: Run of text in one of the typography variants h1 to h5, caption, or body that inherits its color from its container.

## Use when

- Rendering a heading, paragraph, or caption in the design system's type scale.
- Overriding the rendered element while keeping a variant's visual style.

## Avoid when

- Introducing a page section with an eyebrow, description, or actions — use section-heading instead.
- Rendering Markdown content — compose the Markdown renderer instead.

## Keyboard and focus

Text is not interactive and takes no focus, except the "Show all" button a clamped run adds: it is a native button in the tab order with a visible focus ring, and it sits after the run so the clamped text never contains it. Do not add handlers or `tabindex` through rest props unless the element is given an appropriate role.

## Names, roles, and state

Heading order is the caller's responsibility: choose `variant` and `as` so the rendered levels descend without skipping. Color is inherited from the container, so contrast depends on the surface the text sits on; keep it at 4.5:1 for body text and 3:1 for large headings in both themes.

A clamped run's button carries `aria-expanded` and `aria-controls` pointing at the run, and its word changes between "Show all" and "Show less", so the state is never only a chevron or a colour. It appears only while the text is actually cut off. A run cut in the middle with `truncate="middle"` keeps its whole string in the DOM (the ellipsis is drawn by CSS), so assistive technology and copy and paste get the full text, and the same string is the tooltip.

## Verification

- Render Text in the playground or a focused test fixture.
- Inspect the heading outline in browser accessibility tools.
- Check contrast against the container in light and dark themes.

Related components: `section-heading`, `label`.
