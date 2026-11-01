import { getContext, wireCodeOf } from '../../lib/bureau-client.ts';

/**
 * Whether a refused change means the chat is gone. The Bureau answers `NotFound` both for a chat
 * that does not exist and for one the caller may read but not change, so the answer alone proves
 * nothing: the chat is read again, and only a `NotFound` on that read says it is gone. A read that
 * fails any other way proves neither, and is treated as not gone.
 */
export async function chatIsGone(sessionId: string): Promise<boolean> {
  try {
    await getContext(sessionId);
    return false;
  } catch (error) {
    return wireCodeOf(error) === 'NotFound';
  }
}
