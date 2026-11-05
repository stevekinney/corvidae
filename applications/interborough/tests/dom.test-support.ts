/** Return an element after checking its concrete DOM constructor. */
export function requireElement<T extends Element>(
  value: Element | null | undefined,
  constructor: abstract new (...arguments_: never[]) => T,
): T {
  if (!(value instanceof constructor)) {
    throw new TypeError(
      `Expected ${constructor.name}, received ${value?.constructor.name ?? 'nothing'}`,
    );
  }
  return value;
}

/** What `chooseFilterOption` needs of a Testing Library render result. */
export type FilterOptionView = {
  findByRole: (role: string, options: { name: string }) => Promise<HTMLElement>;
  findAllByRole: (role: string) => Promise<HTMLElement[]>;
};

/**
 * Choose an option from a filter bar select, which draws a button that opens a listbox: click the
 * button named `label`, then the option whose text starts with `optionText`.
 */
export async function chooseFilterOption(
  view: FilterOptionView,
  label: string,
  optionText: string,
): Promise<void> {
  const { fireEvent } = await import('@testing-library/svelte');
  await fireEvent.click(await view.findByRole('combobox', { name: label }));
  const options = await view.findAllByRole('option');
  const option = options.find((candidate) => candidate.textContent?.trim().startsWith(optionText));
  if (option === undefined) {
    throw new Error(
      `No "${optionText}" option under ${label}: ${options.map((o) => o.textContent?.trim()).join(', ')}`,
    );
  }
  await fireEvent.click(option);
}
