import { listContexts } from '../../lib/bureau-client.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';

/**
 * Where `/` goes: the chat a person started that was updated most recently, or the chat list when
 * there is none. A session a goal or a schedule's fire started is reached from its run, not here.
 */
export async function chatHomePath(): Promise<string> {
  const page = await listContexts({ origin: 'chat', limit: 1 });
  const newest = page.contexts[0];
  return newest === undefined ? '/chats' : chatSessionPath(newest.id);
}
