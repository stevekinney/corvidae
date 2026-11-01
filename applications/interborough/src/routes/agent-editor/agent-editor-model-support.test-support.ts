/**
 * Drives the agent editor's model field in a component test, the way a person does: open the list,
 * read the options, press one, close the list. The options live in a popover, so they are looked
 * up in the document and not within the field.
 */
import { fireEvent, waitFor } from '@testing-library/svelte';

/** Opens the model field and returns its options, in the order the list shows them. */
export async function openModelOptions(field: HTMLElement): Promise<HTMLElement[]> {
  await fireEvent.input(field, { target: { value: '' } });
  await fireEvent.focus(field);
  const listbox = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="listbox"]');
    if (found === null) throw new Error('Expected the model list to be open.');
    return found;
  });
  return [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
}

/** The name of an option, without what describes it. */
export function optionLabel(option: HTMLElement): string {
  return option.querySelector('[class*="option-label"]')?.textContent?.trim() ?? '';
}

/** What describes an option: its abilities, or the reason it cannot be chosen. */
export function optionDescription(option: HTMLElement): string {
  return option.querySelector('[class*="option-description"]')?.textContent?.trim() ?? '';
}

/** Chooses `value` in the model field: opens it and presses the option. */
export async function chooseModel(field: HTMLElement, value: string): Promise<void> {
  const options = await openModelOptions(field);
  const option = options.find((entry) => optionLabel(entry) === value);
  if (option === undefined) throw new Error(`Expected ${value} to be offered.`);
  await fireEvent.mouseDown(option);
}

/** Closes the list, which puts the chosen model's name back in the field. */
export async function closeModelList(field: HTMLElement): Promise<void> {
  await fireEvent.keyDown(field, { key: 'Escape' });
}
