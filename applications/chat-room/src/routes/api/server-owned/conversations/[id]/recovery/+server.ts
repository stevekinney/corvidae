import { recoverConversationResponse } from '../../../../../../lib/server-owned-recovery-response.ts';

import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => recoverConversationResponse(params.id);
