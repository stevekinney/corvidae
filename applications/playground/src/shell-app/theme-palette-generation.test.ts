import { describe, expect, test } from 'bun:test';

import { cinderThemeBase } from './theme-builder-base.ts';
import {
  CHROMA_GRID_STEPS,
  chromaGrid,
  inOutputGamut,
  largestPassingChroma,
  targetChannels,
} from './theme-chroma-grid.ts';
import { readDtcgColor } from './theme-color-model.ts';
import type { ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { getNode } from './theme-override-tree.ts';
import { generateRoles, parseSeed, roundOklch } from './theme-palette-generation.ts';
import {
  applyPaletteState,
  buildPaletteProposal,
  familyMembers,
  PALETTE_FAMILY_OPTIONS,
  selectedRoles,
  type PaletteProposal,
} from './theme-palette-proposal.ts';

const color = (l: number, c: number, h: number) => ({ l, c, h, alpha: 1 });
const FIXTURE_ROLES = [
  { path: 'x.solid', role: 'solid', anchor: true, color: color(0.5, 0.2, 250) },
  { path: 'x.hover', role: 'hover', anchor: false, color: color(0.4, 0.1, 250) },
  { path: 'x.bg', role: 'bg', anchor: false, color: color(0.95, 0.03, 250) },
];
const proposedOf = (roles: ReturnType<typeof generateRoles>) =>
  roles.map((role) => [role.path, role.proposed, role.gridStep]);

describe('the shared chroma grid', () => {
  test('is 101 descending steps of originalChroma * j / 100', () => {
    const grid = chromaGrid(0.2);
    expect(grid).toHaveLength(CHROMA_GRID_STEPS + 1);
    expect(grid.slice(0, 3)).toEqual([0.2, 0.198, 0.196]);
    expect(grid.at(-1)).toBe(0);
    expect(chromaGrid(0.3)[1]).toBe(0.297);
    expect(grid.every((value, index) => index === 0 || value < grid[index - 1]!)).toBe(true);
  });

  test('pins Culori conversions to the target gamut, unclipped', () => {
    expect(targetChannels(color(0.5, 0.22, 270), 'srgb')).toEqual([
      0.22043065050033833, 0.29829120444100043, 0.868941084823974,
    ]);
    expect(targetChannels(color(0.5, 0.22, 270), 'display-p3')).toEqual([
      0.23643251858912617, 0.2960836187919526, 0.8368511962758385,
    ]);
    expect(inOutputGamut(color(0.5, 0.22, 270), 'srgb')).toBe(true);
    expect(inOutputGamut(color(0.5, 0.4, 270), 'srgb')).toBe(false);
    expect(inOutputGamut(color(0.5, 0.4, 270), 'display-p3')).toBe(false);
  });

  test('picks the largest passing chroma for the selected gamut, pinned', () => {
    expect(largestPassingChroma(0.5, 270, 0.4, 'srgb')).toEqual({ chroma: 0.28, step: 70 });
    expect(largestPassingChroma(0.5, 270, 0.4, 'display-p3')).toEqual({ chroma: 0.3, step: 75 });
    expect(largestPassingChroma(0.5, 270, 0.1, 'srgb')).toEqual({ chroma: 0.1, step: 100 });
  });

  test('a caller predicate narrows the pass, still largest first', () => {
    const accepts = (candidate: { c: number }) => candidate.c <= 0.15;
    expect(largestPassingChroma(0.5, 270, 0.4, 'srgb', accepts)?.chroma).toBeCloseTo(0.148, 12);
  });
});

describe('palette role generation', () => {
  test('accent: the anchor takes the seed; roles keep their lightness offset and scaled chroma', () => {
    const roles = generateRoles({ l: 0.7, c: 0.1, h: 30 }, 'accent', FIXTURE_ROLES, 'srgb');
    expect(proposedOf(roles)).toEqual([
      ['x.solid', { l: 0.7, c: 0.1, h: 30 }, 100],
      ['x.hover', { l: 0.6, c: 0.05, h: 30 }, 100],
      ['x.bg', { l: 1, c: 0, h: 30 }, 0],
    ]);
  });

  test('clamps lightness to 0–1 and reduces chroma into the gamut on the grid', () => {
    const srgb = generateRoles({ l: 0.99, c: 0.3, h: 150 }, 'accent', FIXTURE_ROLES, 'srgb');
    expect(proposedOf(srgb)).toEqual([
      ['x.solid', { l: 0.99, c: 0.015, h: 150 }, 5],
      ['x.hover', { l: 0.89, c: 0.15, h: 150 }, 100],
      ['x.bg', { l: 1, c: 0, h: 150 }, 0],
    ]);
    expect(srgb[0]!.requestedChroma).toBe(0.3);
    for (const role of srgb) expect(inOutputGamut(role.proposed, 'srgb')).toBe(true);
  });

  test('a zero-chroma anchor gives every role the seed chroma', () => {
    const roles = generateRoles(
      { l: 0.6, c: 0.12, h: 200 },
      'accent',
      [
        { ...FIXTURE_ROLES[0]!, color: color(0.5, 0, 0) },
        { ...FIXTURE_ROLES[1]!, color: color(0.4, 0.05, 0) },
      ],
      'srgb',
    );
    expect(roles.map((role) => role.requestedChroma)).toEqual([0.12, 0.12]);
    expect(proposedOf(roles)).toEqual([
      ['x.solid', { l: 0.6, c: 0.102, h: 200 }, 85],
      ['x.hover', { l: 0.5, c: 0.084, h: 200 }, 70],
    ]);
  });

  test('neutral keeps every baseline lightness and takes the seed hue and chroma ratio', () => {
    const roles = generateRoles({ l: 0.7, c: 0.1, h: 30 }, 'neutral', FIXTURE_ROLES, 'srgb');
    expect(proposedOf(roles)).toEqual([
      ['x.solid', { l: 0.5, c: 0.1, h: 30 }, 100],
      ['x.hover', { l: 0.4, c: 0.05, h: 30 }, 100],
      ['x.bg', { l: 0.95, c: 0.015, h: 30 }, 100],
    ]);
  });

  test('is deterministic and a family without an anchor yields nothing', () => {
    const run = () => generateRoles({ l: 0.7, c: 0.1, h: 30 }, 'accent', FIXTURE_ROLES, 'srgb');
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    expect(generateRoles({ l: 0.7, c: 0.1, h: 30 }, 'accent', [], 'srgb')).toEqual([]);
    expect(roundOklch({ l: 0.123456789, c: 0.123456789, h: 12.3456789 })).toEqual({
      l: 0.12346,
      c: 0.12346,
      h: 12.346,
    });
  });

  test('parses a seed in any literal form and rejects text that is not a color', () => {
    const seed = parseSeed('oklch(0.62 0.19 260)');
    expect(seed).toEqual({ ok: true, seed: { l: 0.62, c: 0.19, h: 260 } });
    expect(parseSeed('#fff')).toMatchObject({ ok: true });
    expect(parseSeed('color(display-p3 1 0 0)')).toMatchObject({ ok: true });
    expect(parseSeed('nonsense')).toMatchObject({ ok: false });
    expect(parseSeed('var(--cinder-accent-solid)')).toMatchObject({ ok: false });
  });
});

function proposalFor(
  envelope: ThemeEnvelope,
  family: (typeof PALETTE_FAMILY_OPTIONS)[number]['id'] = 'accent',
  seed = '#0ea5e9',
  locked: ReadonlySet<string> = new Set(),
): PaletteProposal {
  const result = buildPaletteProposal({ seed, family, gamut: 'srgb', envelope, locked });
  if (!result.ok) throw new Error(result.message);
  return result.proposal;
}

const fresh = () => createEnvelope('t', 'T', cinderThemeBase());
const textOf = (proposal: PaletteProposal, mode: 'light' | 'dark', path: string) =>
  proposal.modes[mode].find((role) => role.path === path)?.proposedText;

describe('palette proposals over the shipped baseline', () => {
  test('membership comes only from the catalogue palette metadata', () => {
    expect(familyMembers('accent').map((member) => member.path)).toEqual([
      'accent.text',
      'accent.solid',
    ]);
    expect(familyMembers('danger').map((member) => member.role)).toEqual([
      'solid',
      'solid-active',
      'solid-hover',
      'background',
      'text',
      'border',
    ]);
    for (const option of PALETTE_FAMILY_OPTIONS) {
      const members = familyMembers(option.id);
      expect(members.filter((member) => member.anchor)).toHaveLength(1);
    }
    const everyMember = PALETTE_FAMILY_OPTIONS.flatMap((option) => familyMembers(option.id));
    expect(everyMember.some((member) => member.path.startsWith('terminal.'))).toBe(false);
    expect(everyMember.some((member) => member.path.startsWith('chart.'))).toBe(false);
  });

  test('pins accent proposals for both modes, labeled OKLCH', () => {
    const proposal = proposalFor(fresh());
    expect(textOf(proposal, 'light', 'accent.solid')).toBe('oklch(0.68469 0.14787 237.322)');
    expect(textOf(proposal, 'light', 'accent.text')).toBe('oklch(0.63469 0.139 237.322)');
    expect(textOf(proposal, 'dark', 'accent.solid')).toBe('oklch(0.68469 0.14787 237.322)');
    expect(textOf(proposal, 'dark', 'accent.text')).toBe('oklch(0.68469 0.14787 237.322)');
    for (const role of proposal.modes.light) {
      expect(role.proposed.colorSpace).toBe('oklch');
      expect(role.originalSpace).toBe('oklch');
      expect(role.originalText).toMatch(/^oklch\(/);
    }
  });

  test('pins a status family and a neutral family', () => {
    const success = proposalFor(fresh(), 'success', 'oklch(0.62 0.2 150)');
    expect(textOf(success, 'light', 'status.success.solid')).toBe('oklch(0.62 0.17 150)');
    expect(textOf(success, 'light', 'status.success.background')).toBe('oklch(1 0 150)');
    expect(textOf(success, 'dark', 'status.success.background')).toBe('oklch(0.12 0.033 150)');
    const neutral = proposalFor(fresh(), 'neutral', '#6b7280');
    expect(textOf(neutral, 'light', 'surface.base')).toBe('oklch(0.994 0.0026 264.364)');
    expect(textOf(neutral, 'dark', 'text.default')).toBe('oklch(0.92 0.02336 264.364)');
  });

  test('every proposed value stays inside the selected gamut', () => {
    for (const gamut of ['srgb', 'display-p3'] as const) {
      for (const option of PALETTE_FAMILY_OPTIONS) {
        const result = buildPaletteProposal({
          seed: 'oklch(0.8 0.37 30)',
          family: option.id,
          gamut,
          envelope: fresh(),
          locked: new Set(),
        });
        if (!result.ok) throw new Error(result.message);
        for (const role of [...result.proposal.modes.light, ...result.proposal.modes.dark]) {
          const [l, c, h] = role.proposed.components as number[];
          expect(inOutputGamut({ l: l!, c: c!, h: h! }, gamut)).toBe(true);
          expect(l!).toBeGreaterThanOrEqual(0);
          expect(l!).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test('a draft override never moves the baseline, the offsets, or the anchor', () => {
    const envelope = fresh();
    const overridden: ThemeEnvelope = {
      ...envelope,
      overrides: {
        ...envelope.overrides,
        light: {
          accent: {
            solid: {
              $root: {
                $type: 'color',
                $value: { colorSpace: 'oklch', components: [0.9, 0.01, 10] },
              },
            },
          },
        },
      },
    };
    const before = proposalFor(envelope);
    const after = proposalFor(overridden);
    for (const mode of ['light', 'dark'] as const) {
      expect(after.modes[mode].map((role) => role.baseline)).toEqual(
        before.modes[mode].map((role) => role.baseline),
      );
      expect(after.modes[mode].map((role) => role.proposedText)).toEqual(
        before.modes[mode].map((role) => role.proposedText),
      );
    }
    const solid = after.modes.light.find((role) => role.path === 'accent.solid')!;
    expect(solid.override?.scope).toBe('light');
    expect(solid.originalText).toBe('oklch(0.9 0.01 10)');
  });

  test('preserves the role’s existing alpha and shows the original space beside the proposal', () => {
    const envelope = fresh();
    const withAlpha: ThemeEnvelope = {
      ...envelope,
      overrides: {
        ...envelope.overrides,
        light: {
          accent: {
            text: {
              $root: {
                $type: 'color',
                $value: { colorSpace: 'display-p3', components: [0.2, 0.3, 0.9], alpha: 0.5 },
              },
            },
          },
        },
      },
    };
    const role = proposalFor(withAlpha).modes.light.find((entry) => entry.path === 'accent.text')!;
    expect(role.alpha).toBe(0.5);
    expect(role.proposedText).toMatch(/ \/ 0\.5\)$/);
    expect(role.proposed.alpha).toBe(0.5);
    expect(role.originalSpace).toBe('display-p3');
    expect(role.originalText).toContain('color(display-p3');
  });

  test('a locked token is kept in both modes, and linked aliases are kept and never selected', () => {
    const locked = new Set(['accent.solid']);
    const proposal = proposalFor(fresh(), 'accent', '#0ea5e9', locked);
    const solid = proposal.modes.light.find((role) => role.path === 'accent.solid')!;
    expect(solid.skipped).toBe('locked');
    const all = { modes: new Set(['light', 'dark'] as const), includeOverrides: new Set<string>() };
    expect(selectedRoles(proposal, all).map((role) => role.key)).toEqual([
      'light:accent.text',
      'dark:accent.text',
    ]);
    const aliased = proposalFor(fresh(), 'neutral', '#6b7280');
    expect(aliased.modes.light.every((role) => role.skipped === null)).toBe(true);
  });

  test('an existing override is listed and needs explicit inclusion', () => {
    const envelope = fresh();
    const overridden: ThemeEnvelope = {
      ...envelope,
      overrides: {
        ...envelope.overrides,
        dark: {
          accent: {
            text: {
              $root: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0] } },
            },
          },
        },
      },
    };
    const proposal = proposalFor(overridden);
    const dark = proposal.modes.dark.find((role) => role.path === 'accent.text')!;
    expect(dark.override).toEqual({ scope: 'dark', text: 'color(srgb 1 0 0)' });
    const modes = new Set(['dark'] as const);
    expect(
      selectedRoles(proposal, { modes, includeOverrides: new Set() }).map((role) => role.path),
    ).toEqual(['accent.solid']);
    expect(
      selectedRoles(proposal, { modes, includeOverrides: new Set(['dark:accent.text']) }).map(
        (role) => role.path,
      ),
    ).toEqual(['accent.text', 'accent.solid']);
  });

  test('Apply state writes only the selected modes and is OKLCH with the role metadata kept', () => {
    const envelope = fresh();
    const proposal = proposalFor(envelope);
    const state = applyPaletteState(envelope, proposal, {
      modes: new Set(['light']),
      includeOverrides: new Set(),
    });
    expect(state.overrides.dark).toEqual({});
    expect(state.overrides.shared).toEqual({});
    const solid = getNode(state.overrides.light, 'accent.solid.$root') as {
      $type: string;
      $value: unknown;
    };
    expect(solid.$type).toBe('color');
    expect(readDtcgColor(solid.$value as never)?.colorSpace).toBe('oklch');
    expect(solid.$value).toEqual({ colorSpace: 'oklch', components: [0.68469, 0.14787, 237.322] });
  });

  test('a seed that is not a color is reported and nothing is proposed', () => {
    const result = buildPaletteProposal({
      seed: 'not a color',
      family: 'accent',
      gamut: 'srgb',
      envelope: fresh(),
      locked: new Set(),
    });
    expect(result.ok).toBe(false);
  });
});
