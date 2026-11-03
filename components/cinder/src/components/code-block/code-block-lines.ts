/**
 * Line numbers and notes for highlighted code.
 *
 * A highlighter hands CodeBlock one HTML string, so the block cannot number its lines while it
 * renders them. After the string is in the document this module finds the line elements the
 * highlighter drew (Shiki wraps each line in `<span class="line">`), marks them as CodeBlock lines
 * so one stylesheet numbers plain and highlighted code alike, and inserts each note after its line.
 */
import type { Attachment } from 'svelte/attachments';
import type { CodeBlockAnnotation, CodeBlockAnnotationTone } from './code-block.types.ts';

const svgNamespace = 'http://www.w3.org/2000/svg';

/** The icon paths for each tone: a triangle for a problem, a circled letter for information. */
const glyphs: Record<CodeBlockAnnotationTone, readonly string[]> = {
  danger: [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  warning: [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
};

/** The class a line takes when a note of this tone belongs to it. */
export function lineToneClass(tone: CodeBlockAnnotationTone): string {
  return `cinder-code-block__line--${tone}`;
}

/** The class a note takes for its tone. */
export function annotationToneClass(tone: CodeBlockAnnotationTone): string {
  return `cinder-code-block__annotation--${tone}`;
}

function buildAnnotation(annotation: CodeBlockAnnotation): HTMLElement {
  const tone = annotation.tone ?? 'danger';
  // A `<small>` and not a `<span>`: the stylesheet that keeps Shiki's own span backgrounds and
  // colors off the code (and swaps token colors in dark mode) targets every span in the block.
  const note = document.createElement('small');
  note.className = `cinder-code-block__annotation ${annotationToneClass(tone)}`;
  note.setAttribute('role', 'note');
  const icon = document.createElementNS(svgNamespace, 'svg');
  for (const [name, value] of Object.entries({
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    icon.setAttribute(name, value);
  }
  for (const data of glyphs[tone]) {
    const path = document.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', data);
    icon.append(path);
  }
  note.append(icon, annotation.message);
  return note;
}

/**
 * An attachment that prepares the lines of highlighted code and draws `annotations` under theirs.
 *
 * `onLines` is told whether the highlighter drew line elements at all. A highlighter that does
 * not, such as one that returns a single `<code>` element, cannot be numbered, and the block
 * falls back to its plain rendering, which can.
 */
export function decorateHighlightedLines(
  annotations: readonly CodeBlockAnnotation[] | undefined,
  onLines: (found: boolean) => void,
): Attachment<HTMLElement> {
  return (container) => {
    const lines = [...container.querySelectorAll<HTMLElement>('pre code > .line, code > .line')];
    onLines(lines.length > 0);
    const marked: [HTMLElement, string][] = [];
    const inserted: HTMLElement[] = [];
    for (const line of lines) line.classList.add('cinder-code-block__line');
    for (const annotation of annotations ?? []) {
      const line = lines[Math.trunc(annotation.line) - 1];
      if (!line) continue;
      const toneClass = lineToneClass(annotation.tone ?? 'danger');
      line.classList.add(toneClass);
      marked.push([line, toneClass]);
      // Notes for one line keep the order they were given in.
      let anchor: Element = line;
      while (anchor.nextElementSibling?.classList.contains('cinder-code-block__annotation')) {
        anchor = anchor.nextElementSibling;
      }
      const note = buildAnnotation(annotation);
      anchor.after(note);
      inserted.push(note);
    }
    return () => {
      for (const note of inserted) note.remove();
      for (const [line, toneClass] of marked) line.classList.remove(toneClass);
      for (const line of lines) line.classList.remove('cinder-code-block__line');
    };
  };
}
