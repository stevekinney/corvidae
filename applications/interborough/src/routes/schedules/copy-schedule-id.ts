/**
 * "Copy id": a schedule is named by what it does, so its identifier is shown nowhere on the page
 * and is reached only from the actions menu, which puts it on the clipboard. The person is told
 * whether it was copied, because a browser may refuse the clipboard (an insecure page, or a
 * permission it denies) and a silent failure would look like success.
 */
import { SCHEDULE_COPY } from '../../app/copy.ts';
import { showFault, showToast } from '../../app/toast-host.svelte';

export async function copyScheduleId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id);
    showToast(SCHEDULE_COPY.idCopied);
  } catch (error) {
    showFault({
      kind: 'not-supported',
      message:
        `${SCHEDULE_COPY.idCopyFailed}. ${error instanceof Error ? error.message : ''}`.trim(),
    });
  }
}
