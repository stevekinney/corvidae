/**
 * Draws the run inspector's model as DOM (COR-910). Text goes in with `textContent`, never as
 * markup, so nothing a run reports can become script. The page is a `main` landmark with a heading
 * per section, a polite live region for changes, and one abort button whose name says what it does.
 */
import type { InspectorModel } from './model.ts';

export type RenderHandlers = {
  /** Called when the reader asks to abort the run. */
  readonly onAbort: () => void;
};

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function section(document: Document, id: string, heading: string): HTMLElement {
  const node = element(document, 'section', undefined, { 'aria-labelledby': id });
  node.append(element(document, 'h2', heading, { id }));
  return node;
}

function definitionList(document: Document, rows: readonly (readonly [string, string])[]) {
  const list = element(document, 'dl');
  for (const [term, detail] of rows) {
    list.append(element(document, 'dt', term), element(document, 'dd', detail));
  }
  return list;
}

function evidenceList(
  document: Document,
  label: string,
  entries: readonly { readonly source: string; readonly at: number }[],
  empty: string,
): HTMLElement {
  const list = element(document, 'ul', undefined, { 'aria-label': label });
  if (entries.length === 0) list.append(element(document, 'li', empty));
  for (const entry of entries) {
    list.append(element(document, 'li', `${entry.source} at ${Math.round(entry.at)} ms`));
  }
  return list;
}

/** One-line announcement of what changed between two models, for the live region. */
export function describeChange(
  before: InspectorModel | undefined,
  after: InspectorModel,
): string | null {
  if (before === undefined) return null;
  if (before.lifecycle !== after.lifecycle) return `Run is now ${after.lifecycle}.`;
  if (before.abort.state !== after.abort.state) return `Abort: ${after.abort.state}.`;
  if (before.stream.kind !== after.stream.kind) return `Event stream: ${after.stream.kind}.`;
  return null;
}

/** Replace the contents of `root` with the page for `model`. */
export function renderInspector(
  root: HTMLElement,
  model: InspectorModel,
  handlers: RenderHandlers,
  announcement: string | null,
): void {
  const { ownerDocument: document } = root;
  const main = element(document, 'main', undefined, { 'aria-labelledby': 'inspector-title' });
  main.append(element(document, 'h1', `Run ${model.taskId}`, { id: 'inspector-title' }));

  const lifecycle = section(document, 'inspector-lifecycle', 'Lifecycle');
  lifecycle.append(
    definitionList(document, [
      ['Agent', model.agentName],
      ['Lifecycle', model.lifecycle],
      ['Assessment', model.liveness.assessment],
      ['Reachability', model.liveness.reachability],
      ['Progress state', model.liveness.progress],
      ['Waiting on', model.liveness.wait ?? 'nothing declared'],
    ]),
  );
  main.append(lifecycle);

  const tree = section(document, 'inspector-tree', 'Ownership tree');
  const treeList = element(document, 'ul', undefined, {
    'aria-label': 'Run and the children it owns',
  });
  const parent = element(document, 'li', `${model.tree.label} (${model.tree.status})`);
  const children = element(document, 'ul', undefined, { 'aria-label': 'Children' });
  for (const child of model.tree.children) {
    children.append(element(document, 'li', `${child.label} (${child.status})`));
  }
  if (model.tree.children.length === 0) children.append(element(document, 'li', 'No children'));
  parent.append(children);
  treeList.append(parent);
  tree.append(treeList);
  main.append(tree);

  const progress = section(document, 'inspector-progress', 'Progress evidence');
  progress.append(
    element(document, 'p', model.semanticProgress ?? 'No semantic progress reported.'),
    evidenceList(document, 'Progress evidence', model.progressEvidence, 'No progress evidence.'),
  );
  main.append(progress);

  const signals = section(document, 'inspector-signals', 'Liveness signals');
  signals.append(
    element(
      document,
      'p',
      'Heartbeats and lease renewals show the run is reachable. They are not progress.',
    ),
    evidenceList(document, 'Liveness signals', model.livenessSignals, 'No liveness signals.'),
  );
  main.append(signals);

  const result = section(document, 'inspector-result', 'Result');
  result.append(
    element(
      document,
      'p',
      model.result === null
        ? 'No result yet.'
        : `${model.result.text}${model.result.truncated ? ' (truncated)' : ''}`,
    ),
  );
  main.append(result);

  const stream = section(document, 'inspector-stream', 'Event stream');
  stream.append(
    element(
      document,
      'p',
      model.stream.kind === 'gap'
        ? `Gap: events from ${model.stream.requestedCursor} are no longer retained; the stream resumes at ${model.stream.firstRetainedCursor}.`
        : model.stream.kind === 'removed'
          ? 'The task was removed.'
          : 'Current.',
    ),
  );
  main.append(stream);

  const abort = section(document, 'inspector-abort', 'Abort and cleanup');
  const button = element(document, 'button', 'Abort run', {
    type: 'button',
    id: 'inspector-abort-button',
  });
  button.disabled = !model.abort.available;
  button.addEventListener('click', handlers.onAbort);
  abort.append(
    element(
      document,
      'p',
      `Abort state: ${model.abort.state}. Cleanup: ${model.abort.cleanup ?? 'none'}.`,
    ),
    button,
  );
  main.append(abort);

  // The live region outlives every render, so a change to its text is announced; the focused
  // control is put back on its replacement, so a poll never moves the reader.
  let status = root.querySelector('#inspector-status');
  if (status === null) {
    status = element(document, 'p', '', {
      role: 'status',
      'aria-live': 'polite',
      id: 'inspector-status',
    });
    root.prepend(status);
  }
  if (announcement !== null) status.textContent = announcement;
  const focusedAbort = document.activeElement?.id === 'inspector-abort-button';
  root.querySelector('main')?.remove();
  root.append(main);
  if (focusedAbort) root.querySelector<HTMLElement>('#inspector-abort-button')?.focus();
}
