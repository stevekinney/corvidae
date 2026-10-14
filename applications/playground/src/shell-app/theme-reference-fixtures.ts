/**
 * Test-only fixtures for the reference and composite editors (COR-488): drafts whose shared
 * override carries fixture-only Source tokens, so chains, diamonds and every composite type
 * exist without adding a public token to Cinder.
 */

import { cinderThemeBase } from './theme-builder-base.ts';
import type { JsonObject, ThemeDraft, ThemeEnvelope } from './theme-draft-types.ts';
import { createDraft } from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';

const px = (value: number) => ({ value, unit: 'px' });
const black = { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.5 };

/** Source tokens: a dimension chain a <- b <- c, a diamond d, and one literal of each composite. */
export const SOURCE_TOKENS: JsonObject = {
  fx: {
    a: { $type: 'dimension', $value: px(4), $description: 'Chain root' },
    b: { $type: 'dimension', $value: '{fx.a}' },
    c: { $type: 'dimension', $value: '{fx.b}' },
    other: { $type: 'dimension', $value: px(8) },
    text: { $type: 'color', $value: '{surface.base}' },
    diamond: {
      $type: 'shadow',
      $value: [{ color: black, offsetX: '{fx.b}', offsetY: '{fx.c}', blur: px(2), spread: px(0) }],
    },
    shadow: {
      $type: 'shadow',
      $description: 'Two layers, the second inset',
      $extensions: { 'com.example.vendor': { keep: ['me'] } },
      $value: [
        {
          color: black,
          offsetX: px(0),
          offsetY: px(1),
          blur: px(2),
          spread: px(0),
        },
        {
          color: '{surface.base}',
          offsetX: '{fx.a}',
          offsetY: px(4),
          blur: px(8),
          spread: px(-1),
          inset: true,
        },
      ],
    },
    border: {
      $type: 'border',
      $deprecated: 'Use fx.border-next',
      $value: { color: '{surface.base}', width: px(1), style: 'solid' },
    },
    transition: {
      $type: 'transition',
      $value: {
        duration: { value: 200, unit: 'ms' },
        delay: { value: 0, unit: 'ms' },
        timingFunction: [0.4, 0, 0.2, 1],
      },
    },
    gradient: {
      $type: 'gradient',
      $value: [
        { color: { colorSpace: 'srgb', components: [1, 0, 0] }, position: 0 },
        { color: '{surface.base}', position: 0.5 },
        { color: { colorSpace: 'srgb', components: [0, 0, 1] }, position: 1 },
      ],
    },
    stroke: {
      $type: 'strokeStyle',
      $value: { dashArray: [px(2), '{fx.a}', px(6)], lineCap: 'round' },
    },
    strokeNamed: { $type: 'strokeStyle', $value: 'dashed' },
    typography: {
      $type: 'typography',
      $value: {
        fontFamily: ['Inter', 'system-ui', 'sans-serif'],
        fontSize: '{fx.a}',
        fontWeight: 600,
        letterSpacing: { value: 0.5, unit: 'px' },
        lineHeight: 1.4,
      },
    },
  },
};

export function fixtureEnvelope(
  source: JsonObject = SOURCE_TOKENS,
  id = 'fixture',
  scope: 'shared' | 'light' | 'dark' = 'shared',
): ThemeEnvelope {
  const envelope = createEnvelope(id, 'Fixture', cinderThemeBase());
  return { ...envelope, overrides: { ...envelope.overrides, [scope]: source } };
}

export function fixtureDraft(source: JsonObject = SOURCE_TOKENS, id = 'fixture'): ThemeDraft {
  return createDraft(fixtureEnvelope(source, id));
}
