/**
 * Archives a chat or unarchives it (COR-2285 V5), for the More menu and the Archived bar alike, so
 * the two say the same thing. The receipt's time is written into the chat's own read at once, so
 * the composer turns into the Archived bar (or back) without waiting for the read again, and every
 * list of chats is read again, since the chat lists leave archived chats out. A refusal is said in a
 * toast, as Rename's and Delete's are, in plain words: a chat that is working or waiting on an answer
 * cannot be archived until it is stopped or answered, and a goal's chat cannot be archived at all.
 */
import type { QueryClient } from '@tanstack/svelte-query';

import { CHAT_COPY } from '../../app/copy/chat.ts';
import { showToast } from '../../app/toast-host.svelte';
import {
  archiveContext,
  forkRefusalReason,
  unarchiveContext,
  wireCodeOf,
  type ChatContext,
} from '../../lib/bureau-client.ts';
import { queryKeys } from '../../lib/query.ts';
import { chatIsGone } from './chat-gone.ts';

const COPY = CHAT_COPY.more.archiving;

/** What a refused archive or unarchive says, by the fault it was refused with. */
async function refusalOf(
  error: unknown,
  sessionId: string,
  archive: boolean,
): Promise<{ readonly text: string; readonly variant: 'warning' | 'danger' }> {
  const reason = forkRefusalReason(error);
  if (reason === 'context-busy') return { text: COPY.busy, variant: 'warning' };
  if (reason === 'context-not-archivable') return { text: COPY.notArchivable, variant: 'warning' };
  if (wireCodeOf(error) === 'NotFound') {
    // `NotFound` is also what a caller who may read the chat but not change it is told, so the chat
    // is read again before the page claims it is gone.
    return (await chatIsGone(sessionId))
      ? { text: COPY.gone, variant: 'warning' }
      : { text: COPY.refused, variant: 'danger' };
  }
  return { text: archive ? COPY.archiveFault : COPY.unarchiveFault, variant: 'danger' };
}

/**
 * Archives the chat `sessionId` (`archive: true`) or unarchives it, and says whether it is now as
 * asked. A refusal is told in a toast and changes nothing on the page.
 */
export async function setChatArchived(
  queryClient: QueryClient,
  sessionId: string,
  archive: boolean,
): Promise<boolean> {
  let archivedAt: string | null;
  try {
    ({ archivedAt } = await (archive ? archiveContext(sessionId) : unarchiveContext(sessionId)));
  } catch (error) {
    const { text, variant } = await refusalOf(error, sessionId, archive);
    showToast(text, { variant, duration: 0 });
    return false;
  }
  const stamp = (context: ChatContext | undefined): ChatContext | undefined =>
    context === undefined ? undefined : { ...context, archivedAt };
  queryClient.setQueryData<ChatContext>(queryKeys.contexts.detail(sessionId), stamp);
  queryClient.setQueryData<ChatContext>(queryKeys.contexts.row(sessionId), stamp);
  void queryClient.invalidateQueries({ queryKey: ['contexts'] });
  return true;
}
