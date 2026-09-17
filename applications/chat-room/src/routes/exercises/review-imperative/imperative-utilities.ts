import {
  generateId,
  ReviewEditor,
  timestamp,
  type Comment,
  type Thread,
  type ThreadCreateEvent,
} from '@repo/editor';
import { TextSelection } from 'prosemirror-state';
import { tick } from 'svelte';

export const HEADING = 'Release Plan';
export const PARAGRAPH_ONE =
  'The first release includes a dashboard, export actions, and inline review.';
export const PARAGRAPH_TWO =
  'Reviewers should verify that the export dialog copy matches the product brief before we ship.';
export const PARAGRAPH_THREE = 'Timeline risk: the migration script is untested.';
export const INITIAL = `### ${HEADING}\n\n${PARAGRAPH_ONE}\n\n${PARAGRAPH_TWO}\n\n${PARAGRAPH_THREE}`;
export const AUTHOR_SEED = 'author-1';
export const AUTHOR = AUTHOR_SEED;
export const BLOCK_SHIFT_TEXT = 'Prefixed. ';
export const QUOTE_FROM = 44;
export const QUOTE_TO = 53;

export type ReviewEditorHandle = ReturnType<typeof ReviewEditor>;
export type Outcome = 'refused' | 'completed' | 'created';
export type RecordDetail = { reason?: string; noun?: string; tally?: string };
export type RecordReviewCall = (
  name: string,
  outcome: Outcome,
  result: unknown,
  detail?: RecordDetail,
) => void;

export function threadFromCreateEvent(event: ThreadCreateEvent): Thread {
  const now = timestamp();
  const comment: Comment = {
    id: generateId(),
    threadId: event.requestId,
    authorId: event.authorId,
    body: event.body,
    createdAt: now,
    mentions: event.mentions,
  };
  return { id: event.requestId, anchor: event.anchor, comments: [comment], createdAt: now };
}

function blockIdOf(anchor: Thread['anchor']): string | null {
  if (!anchor || !('blockId' in anchor)) return null;
  const blockId = anchor.blockId;
  return typeof blockId === 'string' ? blockId : null;
}

function anchorType(anchor: Thread['anchor']): string {
  return anchor?.type ?? 'text';
}

function anchorText(anchor: Thread['anchor'], key: 'quote' | 'status'): string | null {
  return anchor?.[key] ?? null;
}

function anchorPosition(
  anchor: Thread['anchor'],
  key: 'from' | 'to' | 'lastKnownOffset',
): number | null {
  return anchor?.[key] ?? null;
}

function anchorRow(thread: Thread) {
  const anchor = thread.anchor;
  return {
    id: thread.id,
    type: anchorType(anchor),
    rawType: anchor?.type ?? null,
    blockId: blockIdOf(anchor),
    quote: anchorText(anchor, 'quote') ?? '',
    from: anchorPosition(anchor, 'from'),
    to: anchorPosition(anchor, 'to'),
    lastKnownOffset: anchorPosition(anchor, 'lastKnownOffset'),
    status: anchorText(anchor, 'status'),
    comments: thread.comments.length,
  };
}

export function anchorRows(list: Thread[]) {
  return list.map(anchorRow);
}

export function compactAnchorRows(list: Thread[]) {
  return list.map((thread) => ({ id: thread.id, type: thread.anchor?.type ?? 'text' }));
}

export function firstThreadId(list: Thread[]): string {
  return list[0]?.id ?? '';
}

export function firstCommentId(list: Thread[]): string {
  return list[0]?.comments[0]?.id ?? '';
}

export function announcementForReviewRecord(
  name: string,
  outcome: Outcome,
  detail: RecordDetail | undefined,
  tally: string,
): string {
  if (outcome === 'refused') {
    return `${name} was refused: ${detail?.reason ?? 'no target was available'}. Nothing changed. ${tally}.`;
  }
  if (outcome === 'created') return `${name} created ${detail?.noun ?? 'a thread'}. ${tally}.`;
  return `${name} completed. ${tally}.`;
}

export async function select(
  target: ReviewEditorHandle | undefined,
  from: number,
  to: number,
): Promise<boolean> {
  const view = target?.getView();
  if (!view) return false;
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  await tick();
  return true;
}

export async function keepingFocus(run: () => Promise<void> | void): Promise<void> {
  const trigger = document.activeElement;
  await run();
  if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
}
