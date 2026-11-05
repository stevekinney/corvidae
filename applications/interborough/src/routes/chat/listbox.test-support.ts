/**
 * Reading and driving the composer's ghost listbox selects (the model picker and the effort and
 * permission selects): each is a combobox button that opens a listbox in the document body, so a
 * test opens it, reads or clicks its options, and closes it again.
 */
import { fireEvent, waitFor } from '@testing-library/svelte';

/** The select's trigger: a combobox button. `id` picks one when a page holds several. */
export function listboxTrigger(container: HTMLElement, id?: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    id === undefined ? '[role="combobox"]' : `[role="combobox"]#${id}`,
  );
  if (found === null) throw new Error('The select did not render.');
  return found;
}

function optionRows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
}

/** Opens the select's listbox and waits for its options. */
export async function openListbox(container: HTMLElement, id?: string): Promise<HTMLElement[]> {
  const trigger = listboxTrigger(container, id);
  if (trigger.getAttribute('aria-expanded') !== 'true') await fireEvent.click(trigger);
  await waitFor(() => {
    if (optionRows().length === 0) throw new Error('The listbox has not opened.');
  });
  return optionRows();
}

/** Closes an open listbox without choosing. */
export async function closeListbox(container: HTMLElement, id?: string): Promise<void> {
  const trigger = listboxTrigger(container, id);
  if (trigger.getAttribute('aria-expanded') === 'true') {
    await fireEvent.keyDown(trigger, { key: 'Escape' });
  }
}

const labelOf = (row: HTMLElement): string =>
  row.querySelector('.cinder-select__option-label')?.textContent ?? '';

/** The words of each option, in order. */
export async function optionLabels(container: HTMLElement, id?: string): Promise<string[]> {
  const rows = await openListbox(container, id);
  const labels = rows.map(labelOf);
  await closeListbox(container, id);
  return labels;
}

/** Whether each option is disabled, in order. */
export async function optionDisabled(container: HTMLElement, id?: string): Promise<boolean[]> {
  const rows = await openListbox(container, id);
  const states = rows.map((row) => row.getAttribute('aria-disabled') === 'true');
  await closeListbox(container, id);
  return states;
}

/** The help line under each option, `undefined` for one with none. */
export async function optionDescriptions(
  container: HTMLElement,
  id?: string,
): Promise<(string | undefined)[]> {
  const rows = await openListbox(container, id);
  const lines = rows.map(
    (row) => row.querySelector('.cinder-select__option-description')?.textContent ?? undefined,
  );
  await closeListbox(container, id);
  return lines;
}

/** The words of the option the trigger shows, without the muted prefix before it. */
export function shownLabel(container: HTMLElement, id?: string): string {
  const trigger = listboxTrigger(container, id);
  return trigger.querySelector('.cinder-select__prefix')?.nextElementSibling?.textContent ?? '';
}

/** The muted words before the value in the trigger. */
export function shownPrefix(container: HTMLElement, id?: string): string {
  return listboxTrigger(container, id).querySelector('.cinder-select__prefix')?.textContent ?? '';
}

/** Opens the listbox and chooses the option with these words. */
export async function chooseOption(
  container: HTMLElement,
  label: string,
  id?: string,
): Promise<void> {
  const rows = await openListbox(container, id);
  const row = rows.find((candidate) => labelOf(candidate) === label);
  if (row === undefined) throw new Error(`The select lists no ${label}.`);
  await fireEvent.click(row);
}
