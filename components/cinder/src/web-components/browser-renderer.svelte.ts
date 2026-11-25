import { createRawSnippet, getAllContexts, setContext, untrack } from 'svelte';

/** A renderer receives live component arguments and returns DOM or plain text. */
type BrowserRenderer<Arguments extends unknown[] = unknown[]> = (
  ...parameters: Arguments
) => Node | string | null | undefined;

const projectedContexts = new WeakMap<Element, Map<unknown, unknown>>();
const authoredContent = new WeakMap<HTMLElement, Map<string, Node[]>>();
const renderers = new WeakMap<BrowserRenderer, ReturnType<typeof browserSnippet>>();
const projections = new WeakMap<Node[], ReturnType<typeof browserSnippet>>();

/** Read authored light-DOM content before the source component inserts its DOM. */
export function readAuthoredContent(host: HTMLElement, names: string[]) {
  const existing = authoredContent.get(host);
  if (existing) return existing;
  const slots = new Map<string, Node[]>();
  for (const node of Array.from(host.childNodes)) {
    if (
      !(node instanceof Element) &&
      (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim())
    )
      continue;
    const slot = (node instanceof Element && node.getAttribute('slot')) || 'children';
    if (!names.includes(slot)) continue;
    const nodes = slots.get(slot);
    if (nodes) nodes.push(node);
    else slots.set(slot, [node]);
    host.removeChild(node);
  }
  authoredContent.set(host, slots);
  return slots;
}

/** Restore the context that was active where the parent projected the child. */
export function inheritProjectedContext(host: HTMLElement) {
  for (let parent = host.parentElement; parent; parent = parent.parentElement) {
    const context = projectedContexts.get(parent);
    if (!context) continue;
    for (const [key, value] of context) setContext(key, value);
    return;
  }
}

/** Turn a browser renderer into a reactive Svelte snippet. */
function browserSnippet(renderer: BrowserRenderer) {
  return createRawSnippet<unknown[]>((...readArguments) => {
    const context = getAllContexts();
    return {
      render: () => '<span class="cinder-browser-content"></span>',
      setup(element) {
        projectedContexts.set(element, context);
        $effect(() => {
          const parameters = readArguments.map((read) => read());
          const content = untrack(() => renderer(...parameters));
          element.replaceChildren(...(content == null ? [] : [content]));
        });
      },
    };
  });
}

/** Project authored nodes, or clone a template for each rendering site. */
export function browserContent(
  value: BrowserRenderer | string | null | undefined,
  nodes: Node[] | undefined,
) {
  if (typeof value === 'function') {
    const existing = renderers.get(value);
    if (existing) return existing;
    const snippet = browserSnippet(value);
    renderers.set(value, snippet);
    return snippet;
  }
  if (value !== undefined || !nodes?.length) return value;
  const existing = projections.get(nodes);
  if (existing) return existing;
  const snippet = browserSnippet(() => {
    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
      fragment.append(node instanceof HTMLTemplateElement ? node.content.cloneNode(true) : node);
    }
    return fragment;
  });
  projections.set(nodes, snippet);
  return snippet;
}
