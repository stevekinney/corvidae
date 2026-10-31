/**
 * How a change to one row of the model catalog becomes the list of catalog edits the host stores
 * (`PUT /host/catalog` replaces the whole list). Every function takes the edits the host reports now
 * and returns the list to send, leaving the argument alone. An edit names its row by the row's model
 * or one of its aliases, so a row's edit is found by either; a row that has no edit gets one under its
 * model name. An edit that has nothing left to say is dropped.
 */
import type { CatalogEdit, ProviderModel, ProviderStatus } from '../../../lib/host-providers.ts';

/** The price and limits a person may set on a row. */
export interface RowFields {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}

/** A row the built-in list lacks, built on one it has. */
export interface AddedRow extends RowFields {
  readonly provider: string;
  readonly model: string;
  /** The model of the same provider whose abilities the new row copies. */
  readonly basedOn: string;
}

/** The currency a price edit uses when the row has no price to take it from. */
const DEFAULT_CURRENCY = 'USD';

function namesRow(edit: CatalogEdit, row: ProviderModel): boolean {
  return (
    edit.provider === row.provider && (edit.model === row.model || row.aliases.includes(edit.model))
  );
}

/** The edit that names `row`, when the configuration has one. */
export function editOf(edits: readonly CatalogEdit[], row: ProviderModel): CatalogEdit | undefined {
  return edits.find((edit) => namesRow(edit, row));
}

/** Whether the edit says nothing beyond which row it names. */
function isEmpty(edit: CatalogEdit): boolean {
  return (
    edit.off !== true &&
    edit.pricing === undefined &&
    edit.contextWindowTokens === undefined &&
    edit.maxOutputTokens === undefined &&
    edit.basedOn === undefined
  );
}

/** The list with `next` where the edit for `row` was, or at the end when it had none. */
function replacing(
  edits: readonly CatalogEdit[],
  row: ProviderModel,
  next: CatalogEdit,
): CatalogEdit[] {
  const position = edits.findIndex((edit) => namesRow(edit, row));
  const kept = isEmpty(next) ? [] : [next];
  if (position === -1) return [...edits, ...kept];
  return [...edits.slice(0, position), ...kept, ...edits.slice(position + 1)];
}

/** The edits with `row` turned off, or back on. A model that is on carries no `off`. */
export function withModelOff(
  edits: readonly CatalogEdit[],
  row: ProviderModel,
  off: boolean,
): CatalogEdit[] {
  const { off: _previous, ...rest } = editOf(edits, row) ?? {
    provider: row.provider,
    model: row.model,
  };
  return replacing(edits, row, off ? { ...rest, off: true } : rest);
}

/**
 * The edits with `row`'s limits and price set to `fields`. Only what differs from the row, or what
 * the row's edit already sets, is written, so a row whose values were not touched gains no edit.
 */
export function withRowFields(
  edits: readonly CatalogEdit[],
  row: ProviderModel,
  fields: RowFields,
): CatalogEdit[] {
  const existing = editOf(edits, row) ?? { provider: row.provider, model: row.model };
  const priceChanged =
    fields.inputPerMillionTokens !== row.pricing?.inputPerMillionTokens ||
    fields.outputPerMillionTokens !== row.pricing?.outputPerMillionTokens;
  const next: CatalogEdit = {
    ...existing,
    ...(fields.contextWindowTokens !== row.contextWindowTokens ||
    existing.contextWindowTokens !== undefined
      ? { contextWindowTokens: fields.contextWindowTokens }
      : {}),
    ...(fields.maxOutputTokens !== row.maxOutputTokens || existing.maxOutputTokens !== undefined
      ? { maxOutputTokens: fields.maxOutputTokens }
      : {}),
    ...(priceChanged || existing.pricing !== undefined
      ? {
          pricing: {
            ...existing.pricing,
            inputPerMillionTokens: fields.inputPerMillionTokens,
            outputPerMillionTokens: fields.outputPerMillionTokens,
            currency: existing.pricing?.currency ?? row.pricing?.currency ?? DEFAULT_CURRENCY,
          },
        }
      : {}),
  };
  return replacing(edits, row, next);
}

/** The edits with a new row appended: it copies `basedOn`'s abilities and takes the limits and price given. */
export function withAddedRow(edits: readonly CatalogEdit[], added: AddedRow): CatalogEdit[] {
  return [
    ...edits,
    {
      provider: added.provider,
      model: added.model,
      basedOn: added.basedOn,
      contextWindowTokens: added.contextWindowTokens,
      maxOutputTokens: added.maxOutputTokens,
      pricing: {
        inputPerMillionTokens: added.inputPerMillionTokens,
        outputPerMillionTokens: added.outputPerMillionTokens,
        currency: DEFAULT_CURRENCY,
      },
    },
  ];
}

/** Whether `model` already names a row of `provider`, by its model or an alias. */
export function namesExistingRow(
  rows: readonly ProviderModel[],
  provider: string,
  model: string,
): boolean {
  return rows.some(
    (row) => row.provider === provider && (row.model === model || row.aliases.includes(model)),
  );
}

/** Whether `provider` has an allowlist that does not name `model`, so the host would not serve it. */
export function allowlistExcludes(
  providers: readonly ProviderStatus[],
  provider: string,
  model: string,
): boolean {
  const allowed = providers.find((entry) => entry.name === provider)?.models;
  return allowed !== undefined && !allowed.includes(model);
}

/** A row of the table: a catalog row as it will be once the edits are saved. */
export interface PreviewRow extends ProviderModel {
  /** Whether the row is one the built-in list lacks, added by an edit. */
  readonly added: boolean;
}

/**
 * The catalog as the table shows it: the rows the host serves with the edits laid over them, so an
 * edit that is not saved yet is already on the page. A row an edit adds appears after the others,
 * copying the abilities of the row it is based on; an edit whose base is not on offer adds nothing.
 */
export function previewRows(
  rows: readonly ProviderModel[],
  edits: readonly CatalogEdit[],
  providers: readonly ProviderStatus[] = [],
): PreviewRow[] {
  const shown: PreviewRow[] = rows.map((row) => {
    const edit = editOf(edits, row);
    if (edit === undefined) return { ...row, added: false };
    return {
      ...row,
      added: edit.basedOn !== undefined,
      off: edit.off === true,
      contextWindowTokens: edit.contextWindowTokens ?? row.contextWindowTokens,
      maxOutputTokens: edit.maxOutputTokens ?? row.maxOutputTokens,
      ...(edit.pricing === undefined
        ? {}
        : {
            pricing: {
              inputPerMillionTokens: edit.pricing.inputPerMillionTokens,
              outputPerMillionTokens: edit.pricing.outputPerMillionTokens,
              currency: edit.pricing.currency,
            },
          }),
    };
  });
  for (const edit of edits) {
    if (edit.basedOn === undefined || rows.some((row) => namesRow(edit, row))) continue;
    // The host drops an added model its provider's allowlist leaves out, so the table does too.
    if (allowlistExcludes(providers, edit.provider, edit.model)) continue;
    const base = rows.find(
      (row) =>
        row.provider === edit.provider &&
        (row.model === edit.basedOn || row.aliases.includes(edit.basedOn ?? '')),
    );
    if (base === undefined) continue;
    shown.push({
      ...base,
      model: edit.model,
      aliases: [],
      added: true,
      off: edit.off === true,
      contextWindowTokens: edit.contextWindowTokens ?? base.contextWindowTokens,
      maxOutputTokens: edit.maxOutputTokens ?? base.maxOutputTokens,
      ...(edit.pricing === undefined
        ? {}
        : {
            pricing: {
              inputPerMillionTokens: edit.pricing.inputPerMillionTokens,
              outputPerMillionTokens: edit.pricing.outputPerMillionTokens,
              currency: edit.pricing.currency,
            },
          }),
    });
  }
  return shown;
}
