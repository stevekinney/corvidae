// What a stacked `fit` table's cards need from the DOM that CSS cannot say alone: which cell is the
// title, which cells have nothing to draw, and which header buttons sort. Every write here is an
// attribute, set only when it differs, so the table's own MutationObserver (children and text)
// never sees its own work and never loops.

const TITLE_ATTRIBUTE = 'data-cinder-stack-title';
const EMPTY_ATTRIBUTE = 'data-cinder-stack-empty';

function setFlag(element: Element, name: string, on: boolean): void {
  if (element.hasAttribute(name) !== on) element.toggleAttribute(name, on);
}

/** A cell with no text and no element in it draws nothing, so its label is not drawn either. */
function isEmptyCell(cell: Element): boolean {
  return (cell.textContent?.trim() ?? '') === '' && cell.children.length === 0;
}

/** The title is the row header, else the first cell with text that holds no control and has a part. */
function titleOf(row: Element): Element | undefined {
  const cells = Array.from(row.children);
  return (
    cells.find((cell) => cell.tagName === 'TH') ??
    cells.find(
      (cell) =>
        !cell.hasAttribute('data-cinder-controls') &&
        !cell.hasAttribute('data-cinder-stack') &&
        !cell.classList.contains('cinder-table__cell--selection') &&
        !isEmptyCell(cell),
    )
  );
}

/** Marks each body row's title cell and its empty cells while the table draws cards. */
export function markCardCells(table: HTMLTableElement): void {
  for (const row of Array.from(table.querySelectorAll(':scope > tbody > tr'))) {
    const title = titleOf(row);
    for (const cell of Array.from(row.children)) {
      setFlag(cell, TITLE_ATTRIBUTE, cell === title);
      setFlag(cell, EMPTY_ATTRIBUTE, cell !== title && isEmptyCell(cell));
    }
  }
}

/** Takes the marks off when the table stops drawing cards. */
export function unmarkCardCells(table: HTMLTableElement): void {
  for (const cell of Array.from(
    table.querySelectorAll(`[${TITLE_ATTRIBUTE}], [${EMPTY_ATTRIBUTE}]`),
  )) {
    cell.removeAttribute(TITLE_ATTRIBUTE);
    cell.removeAttribute(EMPTY_ATTRIBUTE);
  }
}

/** One way to order the rows: a sortable column and a direction. `value` is `index:direction`. */
export type StackSortOption = { value: string; label: string };

function sortButtons(table: HTMLTableElement): { label: string; button: HTMLButtonElement }[] {
  const found: { label: string; button: HTMLButtonElement }[] = [];
  for (const cell of Array.from(table.querySelectorAll(':scope > thead > tr:first-child > th'))) {
    const button = cell.querySelector<HTMLButtonElement>('.cinder-table__sort-button');
    if (button) found.push({ label: cell.textContent?.trim() ?? '', button });
  }
  return found;
}

/** The ways to sort the table, one per sortable column and direction, in the order of its columns. */
export function readSortOptions(table: HTMLTableElement): StackSortOption[] {
  const columns = Array.from(
    table.querySelectorAll(':scope > thead > tr:first-child > th'),
  ).flatMap((cell, index) =>
    cell.querySelector('.cinder-table__sort-button')
      ? [{ index, label: cell.textContent?.trim() ?? '' }]
      : [],
  );
  return columns.flatMap(({ index, label }) => [
    { value: `${index}:ascending`, label: `${label} ascending` },
    { value: `${index}:descending`, label: `${label} descending` },
  ]);
}

/**
 * The header is out of the layout while stacked, and the sort control above the rows stands in for
 * its buttons, so they leave the tab order. Returns the function that puts them back.
 */
export function holdSortButtonsOutOfTabOrder(table: HTMLTableElement): () => void {
  const held = sortButtons(table).map(({ button }) => button);
  for (const button of held) button.tabIndex = -1;
  return () => {
    for (const button of held) button.removeAttribute('tabindex');
  };
}

/** Activates the header button of the chosen column, once or twice, to reach the chosen direction. */
export function applySortOption(
  table: HTMLTableElement,
  value: string,
  directionAfterClick: () => string | undefined,
): void {
  const [index, direction] = value.split(':');
  const cell = table.querySelectorAll(':scope > thead > tr:first-child > th')[Number(index)];
  const button = cell?.querySelector<HTMLButtonElement>('.cinder-table__sort-button');
  if (!button) return;
  button.click();
  if (directionAfterClick() !== direction) button.click();
}
