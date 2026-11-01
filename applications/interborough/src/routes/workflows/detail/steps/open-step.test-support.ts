import { fireEvent, waitFor } from '@testing-library/svelte';

/**
 * Opens the step with this number in the steps list, which shows it beside the list. A step's own
 * affordances (complete an activity, open a stream, read a worker's record) are in that detail, so
 * a test opens the step before it looks for them.
 */
export async function openStepNumber(container: HTMLElement, step: number): Promise<void> {
  const primary = await waitFor(() => {
    // The row's attributes are on its button.
    const control = container.querySelector<HTMLElement>(`[data-step-row="${String(step)}"]`);
    if (control === null) throw new Error(`step ${String(step)} is not listed`);
    return control;
  });
  await fireEvent.click(primary);
}
