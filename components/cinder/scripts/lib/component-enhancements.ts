import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ComponentDiscovery } from './discover-components.ts';

export type ComponentEnhancement = {
  name: string;
  isExperimental: boolean;
  sourcePath: string;
};

/** Return the stable/experimental identity used to match enhancement artifacts. */
export function componentEnhancementKey(
  component: Pick<ComponentDiscovery, 'name' | 'isExperimental'>,
): string {
  return `${component.isExperimental ? 'experimental' : 'stable'}/${component.name}`;
}

/**
 * Discover stable component-owned runtime enhancements.
 *
 * A component contributes an enhancement when its directory contains
 * `<name>-enhancement.ts`.
 */
export function discoverComponentEnhancements(
  components: ReadonlyArray<Pick<ComponentDiscovery, 'name' | 'isExperimental'>>,
  componentsRoot: string,
): ComponentEnhancement[] {
  return components.flatMap((component) => {
    if (component.isExperimental) return [];
    const sourcePath = join(componentsRoot, component.name, `${component.name}-enhancement.ts`);
    return existsSync(sourcePath)
      ? [{ name: component.name, isExperimental: component.isExperimental, sourcePath }]
      : [];
  });
}
