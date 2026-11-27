/**
 * Compile-time regression tests for `Table.HeaderCell`'s `label` (COR-2771). svelte-check processes
 * this file; tsc does not. Every header cell names its column as text, so a stacked table's server
 * HTML carries each body cell's label: a header cell cannot tell whether its table can stack.
 */
import type { Snippet } from 'svelte';

import type { TableHeaderCellProps } from './table-header-cell.types.ts';

declare const children: Snippet;

const labelled: TableHeaderCellProps = { label: 'Namespace', children };
const unnamed: TableHeaderCellProps = { label: '', children };

// @ts-expect-error A header cell without a label is rejected.
const missing: TableHeaderCellProps = { children };

// @ts-expect-error A label is text, never a snippet.
const snippetLabel: TableHeaderCellProps = { label: children, children };

void labelled;
void unnamed;
void missing;
void snippetLabel;
