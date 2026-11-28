/**
 * Compile-time regression tests for the `Table` compound-component namespace.
 * svelte-check processes this file; tsc does not (it excludes .svelte imports).
 *
 * These verify that the `Object.assign` namespace members resolve and stay
 * correctly typed WITHOUT a hand-maintained `as typeof Root & { ... }` cast.
 * If a member is renamed in the `Object.assign` literal, the assignments below
 * stop compiling — surfacing the drift as a type error instead of silently
 * keeping the old declared type.
 */
import type { Component, Snippet } from 'svelte';

import type { TableHeaderCellProps } from '../table-header-cell/table-header-cell.types.ts';

import TableBody from '../table-body/table-body.svelte';
import TableCell from '../table-cell/table-cell.svelte';
import TableHeaderCell from '../table-header-cell/table-header-cell.svelte';
import TableHeader from '../table-header/table-header.svelte';
import TableRow from '../table-row/table-row.svelte';
import { Table } from './index.ts';

const body: typeof TableBody = Table.Body;
const cell: typeof TableCell = Table.Cell;
const header: typeof TableHeader = Table.Header;
const headerCell: typeof TableHeaderCell = Table.HeaderCell;
const row: typeof TableRow = Table.Row;

Table satisfies Component<never>;

// COR-2771: every header cell names its column as text, so a stacked table's server HTML carries
// each body cell's label. A header cell cannot tell whether its table can stack, so it is required.
declare const headerChildren: Snippet;
const labelled: TableHeaderCellProps = { label: 'Namespace', children: headerChildren };
const unnamed: TableHeaderCellProps = { label: '', children: headerChildren };
// @ts-expect-error A header cell without a label is rejected.
const unlabelled: TableHeaderCellProps = { children: headerChildren };
// @ts-expect-error A label is text, never a snippet.
const snippetLabel: TableHeaderCellProps = { label: headerChildren, children: headerChildren };
void labelled;
void unnamed;
void unlabelled;
void snippetLabel;

void body;
void cell;
void header;
void headerCell;
void row;
