/**
 * Measures a captured page for the design review's geometry audit
 * (`scripts/design-review-geometry.ts`, which holds what this records to the rubric's thresholds).
 * `collectGeometryFacts` runs inside the page, so it is one self-contained function: Playwright
 * sends its source to the browser, and nothing outside its body exists there. It only reads the
 * page.
 *
 * It records what a reviewer cannot read off a screenshot: each control's box and the box of the
 * label and icons inside it, the sizes and line heights text is set in, each border's thickness and
 * its contrast against the surface outside it, the left edges content starts on, the gaps between
 * stacked siblings, and wide rows whose content starts far from their leading edge.
 */
import type { Page } from '@playwright/test';

import type { GeometryFacts } from '../../scripts/design-review-geometry.ts';

/** Runs in the page: answers the facts the geometry audit reads. */
export function collectGeometryFacts(): GeometryFacts {
  const CONTROL_SELECTOR =
    'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"]';
  const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="textbox"]';
  const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const viewportWidth = window.innerWidth;

  interface Bounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }

  function half(value: number): number {
    return Math.round(value * 2) / 2;
  }

  function isShown(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    if (rect.right <= 0 || rect.left >= viewportWidth) return false;
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }

  function nameOf(element: Element): string {
    const classes = [...element.classList].filter((name) => !name.startsWith('svelte-'));
    const chosen = classes.find((name) => name.startsWith('cinder-')) ?? classes[0];
    const size = element.getAttribute('data-cinder-size');
    return `${element.tagName.toLowerCase()}${chosen === undefined ? '' : `.${chosen}`}${size === null ? '' : `[size=${size}]`}`;
  }

  function sampleOf(text: string): string {
    return text.replaceAll(/\s+/g, ' ').trim().slice(0, 60);
  }

  function union(bounds: Bounds | null, rect: DOMRect): Bounds {
    if (bounds === null) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
    return {
      left: Math.min(bounds.left, rect.left),
      top: Math.min(bounds.top, rect.top),
      right: Math.max(bounds.right, rect.right),
      bottom: Math.max(bounds.bottom, rect.bottom),
    };
  }

  /** The visible, non-blank text nodes directly or deeply inside `root`. */
  function textNodes(root: Element, deep: boolean): Text[] {
    const nodes: Text[] = [];
    if (!deep) {
      for (const child of root.childNodes) {
        if (child instanceof Text && child.data.trim() !== '') nodes.push(child);
      }
      return nodes;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!(node instanceof Text) || node.data.trim() === '' || parent === null) continue;
      if (SKIPPED_TAGS.has(parent.tagName) || parent.closest('svg') !== null) continue;
      if (isShown(parent)) nodes.push(node);
    }
    return nodes;
  }

  function rectsOf(node: Node): DOMRect[] {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  }

  /** The box around the visible text and icons inside an element. */
  function contentBounds(element: Element): Bounds | null {
    let bounds: Bounds | null = null;
    for (const node of textNodes(element, true)) {
      for (const rect of rectsOf(node)) bounds = union(bounds, rect);
    }
    for (const graphic of element.querySelectorAll('svg, img')) {
      if (isShown(graphic)) bounds = union(bounds, graphic.getBoundingClientRect());
    }
    return bounds;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const resolvedColors = new Map<string, [number, number, number, number]>();

  /** A computed color as red, green and blue from 0 to 255 and alpha from 0 to 1. */
  function colorOf(value: string): [number, number, number, number] {
    const known = resolvedColors.get(value);
    if (known !== undefined) return known;
    let resolved: [number, number, number, number] = [0, 0, 0, 0];
    if (context !== null) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'rgba(0, 0, 0, 0)';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      resolved = [red, green, blue, alpha / 255];
    }
    resolvedColors.set(value, resolved);
    return resolved;
  }

  function over(
    top: [number, number, number, number],
    bottom: [number, number, number],
  ): [number, number, number] {
    const alpha = top[3];
    return [
      top[0] * alpha + bottom[0] * (1 - alpha),
      top[1] * alpha + bottom[1] * (1 - alpha),
      top[2] * alpha + bottom[2] * (1 - alpha),
    ];
  }

  const page: [number, number, number] = window.matchMedia('(prefers-color-scheme: dark)').matches
    ? [18, 18, 18]
    : [255, 255, 255];
  const surfaces = new Map<Element, [number, number, number]>();

  /** The opaque color an element paints, composited over everything behind it. */
  function surfaceOf(element: Element | null): [number, number, number] {
    if (element === null) return page;
    const known = surfaces.get(element);
    if (known !== undefined) return known;
    const surface = over(
      colorOf(getComputedStyle(element).backgroundColor),
      surfaceOf(element.parentElement),
    );
    surfaces.set(element, surface);
    return surface;
  }

  function luminance([red, green, blue]: [number, number, number]): number {
    const channel = (value: number): number => {
      const scaled = value / 255;
      return scaled <= 0.040_45 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  }

  function contrast(first: [number, number, number], second: [number, number, number]): number {
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
  }

  /** Cinder's spacing steps in pixels, from the `--cinder-space-*` properties the page declares. */
  function spaceScale(): number[] {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const steps = new Set<number>();
    const visit = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          for (const property of rule.style) {
            if (!/^--cinder-space-[\d-]+$/.test(property)) continue;
            const declared = /^([\d.]+)(rem|px)?$/.exec(
              rule.style.getPropertyValue(property).trim(),
            );
            if (declared === null) continue;
            const amount = Number.parseFloat(declared[1] ?? '');
            steps.add(half(declared[2] === 'rem' ? amount * rootFontSize : amount));
          }
        }
        if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        // A cross-origin sheet refuses to list its rules, and holds none of Cinder's tokens.
      }
    }
    return [...steps].toSorted((left, right) => left - right);
  }

  function hasExtendedHitArea(element: Element): boolean {
    return ['::before', '::after'].some((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      if (style.content === 'none' || style.position !== 'absolute') return false;
      return [style.top, style.right, style.bottom, style.left].some(
        (inset) => Number.parseFloat(inset) < 0,
      );
    });
  }

  function controlKind(element: Element): GeometryFacts['controls'][number]['kind'] {
    const tag = element.tagName;
    if (tag === 'INPUT') {
      const type = element.getAttribute('type') ?? 'text';
      return type === 'checkbox' || type === 'radio' ? 'other' : 'field';
    }
    if (tag === 'SELECT' || tag === 'TEXTAREA') return 'field';
    // A button that opens a list of values is a select drawn by hand.
    if (element.hasAttribute('aria-haspopup') || element.getAttribute('role') === 'combobox') {
      return 'field';
    }
    if (tag === 'BUTTON' || element.getAttribute('role') === 'button') return 'button';
    if (tag === 'A') return element.className.includes('button') ? 'button' : 'link';
    return 'other';
  }

  function controls(): GeometryFacts['controls'][number][] {
    const found: GeometryFacts['controls'][number][] = [];
    for (const element of document.querySelectorAll(CONTROL_SELECTOR)) {
      if (!isShown(element)) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      // A label cut off with an ellipsis still measures its full length, so keep what the control shows.
      const whole = contentBounds(element);
      const content =
        whole === null
          ? null
          : {
              left: Math.max(whole.left, rect.left),
              top: Math.max(whole.top, rect.top),
              right: Math.min(whole.right, rect.right),
              bottom: Math.min(whole.bottom, rect.bottom),
            };
      const parent = element.parentElement;
      const parentStyle = parent === null ? null : getComputedStyle(parent);
      const available =
        parent === null || parentStyle === null
          ? viewportWidth
          : parent.clientWidth -
            Number.parseFloat(parentStyle.paddingLeft) -
            Number.parseFloat(parentStyle.paddingRight);
      found.push({
        name: nameOf(element),
        kind: controlKind(element),
        text: sampleOf(
          textNodes(element, true)
            .map((node) => node.data)
            .join(' '),
        ),
        accessibleLabel: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '',
        hasIcon: element.querySelector('svg, img') !== null,
        inline: style.display === 'inline',
        rect: {
          x: half(rect.left),
          y: half(rect.top),
          width: half(rect.width),
          height: half(rect.height),
        },
        content:
          content === null
            ? null
            : {
                x: half(content.left),
                y: half(content.top),
                width: half(content.right - content.left),
                height: half(content.bottom - content.top),
              },
        fontSize: Number.parseFloat(style.fontSize),
        boxed:
          colorOf(style.backgroundColor)[3] > 0 ||
          (Number.parseFloat(style.borderTopWidth) > 0 &&
            style.borderTopStyle !== 'none' &&
            colorOf(style.borderTopColor)[3] > 0),
        labelRuns: textNodes(element, true).length,
        extendedHitArea: hasExtendedHitArea(element),
        // Filling a container that hugs it is not stretching, so it must also span half the viewport.
        fullWidth: rect.width >= available - 1 && rect.width >= viewportWidth / 2,
      });
    }
    return found;
  }

  function textStyles(): GeometryFacts['textStyles'][number][] {
    const styles = new Map<
      string,
      {
        -readonly [
          Key in keyof GeometryFacts['textStyles'][number]
        ]: GeometryFacts['textStyles'][number][Key];
      }
    >();
    for (const node of textNodes(document.body, true)) {
      const parent = node.parentElement;
      if (parent === null) continue;
      const style = getComputedStyle(parent);
      const fontSize = Number.parseFloat(style.fontSize);
      const lineHeight = style.lineHeight === 'normal' ? null : Number.parseFloat(style.lineHeight);
      const fontWeight = Number.parseInt(style.fontWeight, 10);
      const tops = new Set(rectsOf(node).map((rect) => Math.round(rect.top / (fontSize / 2))));
      const key = `${fontSize}|${lineHeight ?? 'normal'}|${fontWeight}`;
      const known = styles.get(key);
      if (known === undefined) {
        styles.set(key, {
          fontSize,
          lineHeight,
          fontWeight,
          count: 1,
          multiline: tops.size > 1,
          sample: sampleOf(node.data),
        });
      } else {
        known.count += 1;
        known.multiline ||= tops.size > 1;
      }
    }
    return [...styles.values()];
  }

  function borders(): GeometryFacts['borders'][number][] {
    const found = new Map<
      string,
      { name: string; width: number; contrast: number; interactive: boolean; count: number }
    >();
    for (const element of document.body.querySelectorAll('*')) {
      if (SKIPPED_TAGS.has(element.tagName) || element.closest('svg') !== null) continue;
      const style = getComputedStyle(element);
      const sides = [
        [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
        [style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
        [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
        [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor],
      ] as const;
      let width = 0;
      let color: [number, number, number, number] | null = null;
      for (const [sideWidth, sideStyle, sideColor] of sides) {
        const pixels = Number.parseFloat(sideWidth);
        if (sideStyle === 'none' || sideStyle === 'hidden' || pixels <= width) continue;
        const resolved = colorOf(sideColor);
        if (resolved[3] === 0) continue;
        width = pixels;
        color = resolved;
      }
      if (color === null || !isShown(element)) continue;
      const drawn = over(color, surfaceOf(element));
      const ratio = contrast(drawn, surfaceOf(element.parentElement));
      const name = nameOf(element);
      const key = `${name}|${width}|${ratio}`;
      const known = found.get(key);
      if (known === undefined) {
        found.set(key, {
          name,
          width,
          contrast: ratio,
          // A short box around a field is that field's boundary, as a composer's frame is.
          interactive:
            element.matches(CONTROL_SELECTOR) ||
            (element.getBoundingClientRect().height <= 240 &&
              element.querySelector(FIELD_SELECTOR) !== null),
          count: 1,
        });
      } else {
        known.count += 1;
      }
    }
    return [...found.values()];
  }

  /** Where each block of text starts, counted by left edge. */
  function edges(): GeometryFacts['edges'][number][] {
    const found = new Map<number, { x: number; count: number; samples: string[] }>();
    for (const element of document.body.querySelectorAll('*')) {
      if (SKIPPED_TAGS.has(element.tagName) || element.closest('svg') !== null) continue;
      if (textNodes(element, false).length === 0 || !isShown(element)) continue;
      if (element.closest(CONTROL_SELECTOR) !== null) continue;
      const style = getComputedStyle(element);
      if (style.textAlign !== 'start' && style.textAlign !== 'left') continue;
      const parent = element.parentElement;
      const continuesLine =
        style.display.startsWith('inline') &&
        parent !== null &&
        (textNodes(parent, false).length > 0 || element.previousElementSibling !== null);
      if (continuesLine) continue;
      const [first] = rectsOf(element);
      if (first === undefined) continue;
      const x = half(first.left);
      const known = found.get(x);
      if (known === undefined) found.set(x, { x, count: 1, samples: [nameOf(element)] });
      else {
        known.count += 1;
        if (known.samples.length < 2 && !known.samples.includes(nameOf(element))) {
          known.samples.push(nameOf(element));
        }
      }
    }
    return [...found.values()];
  }

  /** The gaps between the children of every container that stacks three or more of them. */
  function stacks(): GeometryFacts['stacks'][number][] {
    const found: GeometryFacts['stacks'][number][] = [];
    for (const element of document.body.querySelectorAll('*')) {
      if (element.children.length < 3 || element.closest('svg') !== null) continue;
      const children = [...element.children].filter((child) => {
        const position = getComputedStyle(child).position;
        return position !== 'absolute' && position !== 'fixed' && isShown(child);
      });
      if (children.length < 3) continue;
      const gaps: number[] = [];
      let stacked = true;
      for (const [index, child] of children.entries()) {
        const next = children[index + 1];
        if (next === undefined) break;
        const gap = next.getBoundingClientRect().top - child.getBoundingClientRect().bottom;
        if (gap < -0.5) {
          stacked = false;
          break;
        }
        gaps.push(half(Math.max(gap, 0)));
      }
      if (!stacked || gaps.every((gap) => gap === 0)) continue;
      const names = new Set(children.map((child) => nameOf(child)));
      found.push({ name: nameOf(element), uniformChildren: names.size === 1, gaps });
    }
    return found;
  }

  /** Wide, short rows whose content starts well inside their leading edge, each naming the row around it. */
  function leadingSpace(): GeometryFacts['leadingSpace'][number][] {
    const outlet = document.querySelector('main') ?? document.body;
    const outletWidth = outlet.getBoundingClientRect().width;
    const found: GeometryFacts['leadingSpace'][number][] = [];
    const visit = (element: Element, within: number | null): void => {
      if (!isShown(element) || element.closest('svg') !== null) return;
      let around = within;
      const rect = element.getBoundingClientRect();
      if (rect.width >= outletWidth * 0.6 && rect.height <= 240) {
        const content = contentBounds(element);
        const style = getComputedStyle(element);
        const start =
          rect.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft);
        const end =
          rect.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        if (content !== null && content.left - start >= 24 && end > start) {
          found.push({
            name: nameOf(element),
            width: half(end - start),
            leading: half(content.left - start),
            trailing: half(Math.max(end - content.right, 0)),
            within,
            sample: sampleOf(
              textNodes(element, true)
                .map((node) => node.data)
                .join(' '),
            ),
          });
          around = found.length - 1;
        }
      }
      for (const child of element.children) visit(child, around);
    };
    visit(outlet, null);
    return found;
  }

  return {
    viewport: { width: viewportWidth, height: window.innerHeight },
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    spaceScale: spaceScale(),
    controls: controls(),
    textStyles: textStyles(),
    borders: borders(),
    edges: edges(),
    stacks: stacks(),
    leadingSpace: leadingSpace(),
  };
}

/** Measures the page as it stands. */
export async function measureGeometry(page: Page): Promise<GeometryFacts> {
  return page.evaluate(collectGeometryFacts);
}
