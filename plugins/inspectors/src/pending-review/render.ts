/**
 * Draws the pending-review model as DOM (COR-910). Text goes in with `textContent`, never as
 * markup. The page is a `main` landmark with one labelled section per review, a polite live region
 * for outcomes, and buttons whose group names which review they decide. Focus and a half-typed
 * reason survive every redraw.
 */
import type { ReviewView } from './model.ts';

export type RowState = {
  /** A decision is in flight: no button is offered. */
  readonly busy: boolean;
  /** What the last attempt on this review said. */
  readonly outcome: string | null;
  /** The reject form is open. */
  readonly rejecting: boolean;
  /** The reject reason typed so far. */
  readonly draft: string;
};

export type ReviewHandlers = {
  readonly onDecide: (id: string, decision: 'approve' | 'deny') => void;
  readonly onOpenReject: (id: string) => void;
  readonly onCancelReject: (id: string) => void;
  readonly onDraft: (id: string, text: string) => void;
  readonly onReject: (id: string) => void;
};

const IDLE: RowState = { busy: false, outcome: null, rejecting: false, draft: '' };

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

function button(
  document: Document,
  label: string,
  key: string,
  disabled: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const node = element(document, 'button', label, { type: 'button', 'data-focus': key });
  node.disabled = disabled;
  node.addEventListener('click', onClick);
  return node;
}

function rejectForm(
  document: Document,
  view: ReviewView,
  state: RowState,
  handlers: ReviewHandlers,
): HTMLElement {
  const form = element(document, 'div');
  form.append(element(document, 'label', 'Feedback for the agent', { for: `reason-${view.id}` }));
  const area = element(document, 'textarea', undefined, {
    id: `reason-${view.id}`,
    rows: '3',
    'data-focus': `reason:${view.id}`,
  });
  area.value = state.draft;
  area.addEventListener('input', () => handlers.onDraft(view.id, area.value));
  const send = button(
    document,
    'Send rejection',
    `send:${view.id}`,
    state.busy || state.draft.trim() === '',
    () => handlers.onReject(view.id),
  );
  // The draft is kept outside the DOM, so the button follows it without a redraw.
  area.addEventListener('input', () => {
    send.disabled = state.busy || area.value.trim() === '';
  });
  form.append(
    area,
    send,
    button(document, 'Cancel', `cancel:${view.id}`, state.busy, () =>
      handlers.onCancelReject(view.id),
    ),
  );
  return form;
}

/** Replace the contents of `root` with the queue for `views`. */
export function renderReviews(
  root: HTMLElement,
  views: readonly ReviewView[],
  states: ReadonlyMap<string, RowState>,
  handlers: ReviewHandlers,
  announcement: string | null,
  notice: string | null,
): void {
  const { ownerDocument: document } = root;
  const active = document.activeElement;
  const focusKey = active?.getAttribute('data-focus') ?? null;
  const selection =
    active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;

  const main = element(document, 'main', undefined, { 'aria-labelledby': 'reviews-title' });
  main.append(
    element(document, 'h1', `Pending reviews (${views.length})`, { id: 'reviews-title' }),
  );
  if (notice !== null) main.append(element(document, 'p', notice));
  if (views.length === 0) main.append(element(document, 'p', 'Nothing is waiting for a decision.'));

  for (const view of views) {
    const state = states.get(view.id) ?? IDLE;
    const headingId = `review-${view.id}`;
    const card = element(document, 'section', undefined, { 'aria-labelledby': headingId });
    card.append(element(document, 'h2', view.title, { id: headingId }));
    const list = element(document, 'ul', undefined, { 'aria-label': `Details of ${view.title}` });
    for (const line of view.detail) list.append(element(document, 'li', line));
    card.append(list);
    if (state.outcome !== null) card.append(element(document, 'p', state.outcome));

    const locked = !view.decidable || state.busy;
    const actions = element(document, 'div', undefined, {
      role: 'group',
      'aria-label': `Decide ${view.title}`,
    });
    actions.append(
      button(document, 'Approve', `approve:${view.id}`, locked, () =>
        handlers.onDecide(view.id, 'approve'),
      ),
      button(document, 'Deny', `deny:${view.id}`, locked, () => handlers.onDecide(view.id, 'deny')),
      button(document, 'Reject with feedback', `open:${view.id}`, locked, () =>
        handlers.onOpenReject(view.id),
      ),
    );
    card.append(actions);
    if (state.rejecting && view.decidable) card.append(rejectForm(document, view, state, handlers));
    main.append(card);
  }

  let status = root.querySelector('#reviews-status');
  if (status === null) {
    status = element(document, 'p', '', {
      role: 'status',
      'aria-live': 'polite',
      id: 'reviews-status',
    });
    root.prepend(status);
  }
  if (announcement !== null) status.textContent = announcement;
  root.querySelector('main')?.remove();
  root.append(main);

  if (focusKey !== null) {
    const next = [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(
      (candidate) => candidate.getAttribute('data-focus') === focusKey,
    );
    next?.focus();
    if (next instanceof HTMLTextAreaElement && selection?.[0] != null) {
      next.setSelectionRange(selection[0], selection[1] ?? selection[0]);
    }
  }
}
