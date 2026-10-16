/**
 * Which reference scenes and states render each kind of pairing (COR-259). The scene manifest
 * (`theme-preview-scenes.ts`) records which states a scene exposes; this module says which
 * pairing groups appear in which scene, so a finding can point at the exact preview state.
 *
 * A pairing group with no scene (terminal colors, disabled states no example renders) is still
 * checked statically, and its records say so in `untested` instead of claiming scene coverage.
 */

import type { PairingGroup } from '@lostgradient/cinder/tokens/runtime';

import type { SceneReference } from './theme-check-types.ts';
import { themePreviewSceneById, type ThemePreviewState } from './theme-preview-scenes.ts';

type Site = { sceneId: string; state: ThemePreviewState; background: string };

const TEXT_SITES: Site[] = [
  { sceneId: 'foundations/specimens', state: 'default', background: 'canvas' },
  { sceneId: 'components/link-basic', state: 'default', background: 'canvas' },
  { sceneId: 'data/table-basic', state: 'default', background: 'surface' },
  { sceneId: 'application/settings-dashboard', state: 'default', background: 'surface' },
];

const SITES: Record<PairingGroup, Site[]> = {
  text: TEXT_SITES,
  accent: [
    { sceneId: 'components/button-variants', state: 'default', background: 'accent' },
    { sceneId: 'components/button-variants', state: 'hover', background: 'accent' },
    { sceneId: 'components/button-variants', state: 'active-selected', background: 'accent' },
    { sceneId: 'components/tabs-basic', state: 'active-selected', background: 'surface' },
  ],
  status: [{ sceneId: 'feedback/callout-variants', state: 'default', background: 'status' }],
  severity: [
    { sceneId: 'application/settings-dashboard', state: 'default', background: 'surface' },
  ],
  terminal: [],
  focus: [
    { sceneId: 'components/button-variants', state: 'focus-visible', background: 'canvas' },
    { sceneId: 'forms/input-basic', state: 'focus-visible', background: 'canvas' },
    { sceneId: 'forms/checkbox-basic', state: 'focus-visible', background: 'canvas' },
    { sceneId: 'components/tabs-basic', state: 'focus-visible', background: 'canvas' },
  ],
  'control-border': [
    { sceneId: 'forms/input-basic', state: 'default', background: 'surface' },
    { sceneId: 'forms/select-basic', state: 'default', background: 'surface' },
    { sceneId: 'forms/checkbox-basic', state: 'default', background: 'surface' },
    { sceneId: 'components/button-variants', state: 'default', background: 'surface' },
  ],
  chart: [{ sceneId: 'charts/line-chart-multi-series', state: 'default', background: 'surface' }],
  'decorative-border': [
    { sceneId: 'data/table-basic', state: 'default', background: 'surface' },
    { sceneId: 'overlay/popover-basic', state: 'open', background: 'raised' },
  ],
  polarity: [{ sceneId: 'foundations/specimens', state: 'default', background: 'canvas' }],
  disabled: [],
};

/** The scene sites that render a group, keeping only scenes whose state the manifest exposes. */
export function sceneSitesFor(group: PairingGroup): SceneReference[] {
  return SITES[group]
    .filter((site) => {
      const support = themePreviewSceneById(site.sceneId)?.states[site.state];
      return support?.applicable === true;
    })
    .map(({ sceneId, state, background }) => ({ sceneId, state, background }));
}

/** Every scene id this module names, for the test that checks them against the manifest. */
export function referencedSceneIds(): string[] {
  return [...new Set(Object.values(SITES).flatMap((sites) => sites.map((site) => site.sceneId)))];
}
