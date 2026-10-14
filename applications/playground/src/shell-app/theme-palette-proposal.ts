/**
 * Palette proposals over a theme draft (COR-263): which tokens belong to a family (from the
 * catalogue's explicit palette metadata only), what each role's immutable baseline is in each
 * concrete color mode, what the draft holds now, and the one editable state an Apply commits.
 *
 * The baseline is read from a fresh envelope over the draft's embedded base, so draft
 * overrides never change an offset, an anchor value, or a chroma ratio. Light and dark
 * proposals are generated separately. Locked roles and aliases are kept as they are, and a
 * role that already carries an explicit override is listed and applied only when it is
 * explicitly included.
 */

import { AUTHORING_CATALOGUE, type PaletteFamily } from '@lostgradient/cinder/tokens/runtime';

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import type { OutputGamut } from './theme-chroma-grid.ts';
import {
  authoredOklch,
  authoredText,
  colorToJson,
  oklchColor,
  oklchText,
  readDtcgColor,
  type DtcgColor,
  type OklchValue,
} from './theme-color-model.ts';
import type {
  EditableState,
  JsonObject,
  OverrideScope,
  ThemeEnvelope,
} from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { getNode, setNode } from './theme-override-tree.ts';
import {
  generateRoles,
  PALETTE_ALGORITHM_VERSION,
  parseSeed,
  type RoleBaseline,
} from './theme-palette-generation.ts';
import { editorMode, literalValueOf, overrideValue, sourcePathOf } from './theme-token-edit.ts';

export type PaletteColorMode = 'light' | 'dark';
export const PALETTE_COLOR_MODES: readonly PaletteColorMode[] = ['light', 'dark'];

export type PaletteFamilyOption = { id: PaletteFamily; label: string };
export const PALETTE_FAMILY_OPTIONS: readonly PaletteFamilyOption[] = [
  { id: 'accent', label: 'Accent' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'success', label: 'Success' },
  { id: 'warning', label: 'Warning' },
  { id: 'danger', label: 'Danger' },
  { id: 'info', label: 'Info' },
];

export type FamilyMember = { path: string; role: string; anchor: boolean };

/** The members of a family, in catalogue order, from the explicit palette metadata only. */
export function familyMembers(family: PaletteFamily): FamilyMember[] {
  return AUTHORING_CATALOGUE.records.flatMap((record) => {
    const palette = record.palette;
    if (palette === undefined || palette.family !== family) return [];
    return [{ path: record.path, role: palette.role, anchor: palette.anchor }];
  });
}

export type SkipReason = 'locked' | 'alias' | 'not-a-color';

export type RoleProposal = {
  /** `<mode>:<path>`, the key selections and locks use for one role in one mode. */
  key: string;
  path: string;
  name: string;
  role: string;
  anchor: boolean;
  colorMode: PaletteColorMode;
  baseline: OklchValue;
  /** The proposed OKLCH value, labeled OKLCH, with the role's existing alpha. */
  proposed: DtcgColor;
  proposedText: string;
  /** What the draft holds now, in its own space. */
  originalSpace: string;
  originalText: string;
  alpha: number;
  /** The chroma the ratio asked for when the gamut reduced it, otherwise `null`. */
  reducedFromChroma: number | null;
  /** The explicit override already on this role in this mode, if any. */
  override: { scope: OverrideScope; text: string } | null;
  skipped: SkipReason | null;
};

export type PaletteProposal = {
  family: PaletteFamily;
  seedText: string;
  gamut: OutputGamut;
  version: string;
  modes: Record<PaletteColorMode, RoleProposal[]>;
};

export type ProposalResult =
  { ok: true; proposal: PaletteProposal } | { ok: false; message: string };

const contextOf = (colorMode: PaletteColorMode) => ({ colorMode, motion: 'default' as const });

export const roleKey = (colorMode: PaletteColorMode, path: string): string =>
  `${colorMode}:${path}`;

function baselinesFor(
  base: ThemeEnvelope,
  colorMode: PaletteColorMode,
  members: readonly FamilyMember[],
): RoleBaseline[] {
  return members.flatMap((member) => {
    const color = readDtcgColor(literalValueOf(base, contextOf(colorMode), member.path));
    return color === null
      ? []
      : [
          {
            path: member.path,
            role: member.role,
            anchor: member.anchor,
            color: authoredOklch(color),
          },
        ];
  });
}

function overrideOf(
  envelope: ThemeEnvelope,
  colorMode: PaletteColorMode,
  path: string,
): RoleProposal['override'] {
  for (const scope of [colorMode, 'shared'] as const) {
    const value = overrideValue(envelope, scope, path);
    if (value === undefined) continue;
    const color = readDtcgColor(value);
    return { scope, text: color === null ? JSON.stringify(value) : authoredText(color) };
  }
  return null;
}

/**
 * Both color modes' proposals for a seed and family. Locked roles are kept as they are and
 * never proposed. A role the draft has rebound to an alias stays linked and is not proposed.
 */
export function buildPaletteProposal(input: {
  seed: string;
  family: PaletteFamily;
  gamut: OutputGamut;
  envelope: ThemeEnvelope;
  locked: ReadonlySet<string>;
}): ProposalResult {
  const parsed = parseSeed(input.seed);
  if (!parsed.ok) return parsed;
  const members = familyMembers(input.family);
  if (!members.some((member) => member.anchor)) {
    return { ok: false, message: `The ${input.family} family declares no anchor.` };
  }
  const base = createEnvelope('baseline', 'Cinder baseline', input.envelope.base);
  const modes = { light: [], dark: [] } as Record<PaletteColorMode, RoleProposal[]>;
  for (const colorMode of PALETTE_COLOR_MODES) {
    const generated = generateRoles(
      parsed.seed,
      input.family,
      baselinesFor(base, colorMode, members),
      input.gamut,
    );
    modes[colorMode] = generated.map((role): RoleProposal => {
      const row = catalogueRowByPath(role.path);
      const key = roleKey(colorMode, role.path);
      const current = readDtcgColor(
        literalValueOf(input.envelope, contextOf(colorMode), role.path),
      );
      const scope: OverrideScope = colorMode;
      const aliased = row !== undefined && editorMode(row, input.envelope, scope) === 'alias';
      const alpha = current?.alpha ?? role.baseline.alpha;
      const proposed = oklchColor({ ...role.proposed, alpha });
      const skipped: SkipReason | null = input.locked.has(key)
        ? 'locked'
        : aliased
          ? 'alias'
          : current === null
            ? 'not-a-color'
            : null;
      return {
        key,
        path: role.path,
        name: row?.name ?? role.path,
        role: role.role,
        anchor: role.anchor,
        colorMode,
        baseline: role.baseline,
        proposed,
        proposedText: oklchText({ ...role.proposed, alpha }),
        originalSpace: current?.colorSpace ?? 'unknown',
        originalText: current === null ? 'not a literal color' : authoredText(current),
        alpha,
        reducedFromChroma: role.gridStep === 100 ? null : role.requestedChroma,
        override: overrideOf(input.envelope, colorMode, role.path),
        skipped,
      };
    });
  }
  return {
    ok: true,
    proposal: {
      family: input.family,
      seedText: input.seed.trim(),
      gamut: input.gamut,
      version: PALETTE_ALGORITHM_VERSION,
      modes,
    },
  };
}

export type PaletteSelection = {
  /** The color modes that commit. */
  modes: ReadonlySet<PaletteColorMode>;
  /** Role keys whose existing explicit override may be replaced. */
  includeOverrides: ReadonlySet<string>;
};

/** The roles a selection would write: not skipped, mode selected, override explicitly included. */
export function selectedRoles(
  proposal: PaletteProposal,
  selection: PaletteSelection,
): RoleProposal[] {
  return PALETTE_COLOR_MODES.filter((mode) => selection.modes.has(mode)).flatMap((mode) =>
    proposal.modes[mode].filter(
      (role) =>
        role.skipped === null &&
        (role.override === null || selection.includeOverrides.has(role.key)),
    ),
  );
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The editable state an Apply commits: each selected role becomes an OKLCH override in its
 * color mode's scope, keeping whatever metadata the override node already carried. Contexts
 * that were not selected are untouched, so only the chosen modes change.
 */
export function applyPaletteState(
  envelope: ThemeEnvelope,
  proposal: PaletteProposal,
  selection: PaletteSelection,
): EditableState {
  const overrides = { ...envelope.overrides };
  for (const role of selectedRoles(proposal, selection)) {
    const scope: OverrideScope = role.colorMode;
    const sourcePath = sourcePathOf(envelope, role.path);
    const existing = getNode(overrides[scope], sourcePath);
    const base: JsonObject = isObject(existing) ? existing : {};
    const node: JsonObject = {
      ...base,
      ...('$type' in base ? {} : { $type: 'color' }),
      $value: colorToJson(role.proposed),
    };
    overrides[scope] = setNode(overrides[scope], sourcePath, node);
  }
  return { overrides, cssOverrides: envelope.cssOverrides };
}
