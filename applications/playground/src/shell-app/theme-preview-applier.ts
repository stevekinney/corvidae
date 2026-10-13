/**
 * Applies a validated theme preview message to the PREVIEW document, and only to it.
 *
 * The applier is handed the frame's own `Document`; it has no reference to the parent,
 * so a theme value can never style builder chrome. Variables go onto the document root
 * and onto the portal container (Cinder's `Portal` appends to `document.body` by
 * default, and an element can opt in with `data-theme-preview-portal`). Every apply
 * REPLACES the whole variable map: anything this applier set before, and any other
 * inline `--cinder-*` property on a target, is removed first, so a reset or a frame
 * reload cannot leave a stale custom property behind.
 *
 * The context (color mode and motion) is expressed as attributes the shipped Cinder
 * CSS already reads. The token VALUES a motion mode implies belong to the shared token
 * runtime; this applier only sets the attributes and the explicit overrides it was sent.
 */

import type { ThemePreviewContext, ThemePreviewProperty } from './theme-preview-message.ts';

export const PORTAL_MARKER_ATTRIBUTE = 'data-theme-preview-portal';
export const MOTION_CONTEXT_ATTRIBUTE = 'data-cinder-motion';

const PUBLIC_PREFIX = '--cinder-';

export class ThemePreviewApplier {
  readonly #document: Document;
  #applied = new Set<string>();

  constructor(document: Document) {
    this.#document = document;
  }

  /** The elements that receive the variable map: the document root and each portal container. */
  targets(): HTMLElement[] {
    const root = this.#document.documentElement;
    const found = new Set<HTMLElement>([root]);
    if (this.#document.body !== null) found.add(this.#document.body);
    for (const portal of this.#document.querySelectorAll<HTMLElement>(
      `[${PORTAL_MARKER_ATTRIBUTE}]`,
    )) {
      found.add(portal);
    }
    return [...found];
  }

  /** The names applied by the latest `apply`, in application order. */
  appliedNames(): readonly string[] {
    return [...this.#applied];
  }

  /** Replace the whole variable map and switch to `context`. */
  apply(context: ThemePreviewContext, properties: readonly ThemePreviewProperty[]): void {
    this.#applyContext(context);
    for (const target of this.targets()) {
      this.#clear(target);
      for (const { name, value } of properties) target.style.setProperty(name, value);
    }
    this.#applied = new Set(properties.map((property) => property.name));
  }

  /** Remove every applied variable, keeping `context`. */
  reset(context: ThemePreviewContext): void {
    this.apply(context, []);
  }

  #clear(target: HTMLElement): void {
    const stale = new Set(this.#applied);
    for (let index = 0; index < target.style.length; index += 1) {
      const name = target.style.item(index);
      if (name.startsWith(PUBLIC_PREFIX)) stale.add(name);
    }
    for (const name of stale) target.style.removeProperty(name);
  }

  #applyContext(context: ThemePreviewContext): void {
    const root = this.#document.documentElement;
    root.style.colorScheme = context.colorMode;
    root.dataset['theme'] = context.colorMode;
    root.dataset['cinderTheme'] = context.colorMode;
    // `default` pins full motion even under an operating-system reduced-motion preference, so a
    // context means the same thing on every machine; both reduced contexts opt in explicitly.
    root.dataset['reducedMotion'] = context.motion === 'default' ? 'off' : 'on';
    root.setAttribute(MOTION_CONTEXT_ATTRIBUTE, context.motion);
  }
}
