// What a stacked `fit` table's cards need from the DOM that CSS cannot say alone: which cell is the
// title, which cells have nothing to draw, and which header buttons leave the tab order. Every write
// here is an attribute, set only when it differs, so the table's own MutationObserver (children and
// text) never sees its own work and never loops.

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

/**
 * The header is out of the layout while stacked, and the sort control above the rows stands in for
 * its buttons, so they leave the tab order. Returns the function that puts them back.
 */
export function holdSortButtonsOutOfTabOrder(table: HTMLTableElement): () => void {
  const held = Array.from(
    table.querySelectorAll<HTMLButtonElement>(
      ':scope > thead > tr:first-child > th .cinder-table__sort-button',
    ),
  );
  for (const button of held) button.tabIndex = -1;
  return () => {
    for (const button of held) button.removeAttribute('tabindex');
  };
}
