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
import type { Component } from 'svelte';

import type { DataTableProps } from '../data-table/data-table.types.ts';

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

void body;
void cell;
void header;
void headerCell;
void row;

// DataTable preserves the compositional Table layout constraints on its public props.
const data = { columns: [], rows: [] };
const fit: DataTableProps = { ...data, fit: true, selectable: 'multiple' };
// @ts-expect-error Fit layout cannot resize columns.
const resizableFit: DataTableProps = { ...data, fit: true, resizable: true };
// @ts-expect-error Fit layout cannot virtualize rows.
const virtualizedFit: DataTableProps = { ...data, fit: true, virtualized: true };
void [fit, resizableFit, virtualizedFit];
