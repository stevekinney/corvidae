/**
 * The static production gate's case list.
 *
 * A case is one (route, view, viewport). Every component route (`/page/<name>`) runs its
 * Documentation and Playground views at 1440px and 390px; every other canonical route runs its one
 * page at both widths. The list is sorted by case id in code-unit order, so it is the same on every
 * machine, and a shard takes every `count`-th case starting at `index - 1`, which spreads expensive
 * component routes across shards.
 */

export const STATIC_VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
] as const;

export type StaticCaseView = 'documentation' | 'playground' | 'page' | 'navigation';

/**
 * The spec's one interaction case, which is not a route check: a component-to-component click on
 * the static export swaps the page in place. It is in the case list, under the test's own title,
 * so it is counted with the route cases and runs in exactly one shard.
 */
export const IN_PLACE_NAVIGATION_CASE_ID =
  'a component-to-component click swaps the page in place on the static export';
const IN_PLACE_NAVIGATION_ROUTES = ['/page/button', '/page/chat'] as const;

export type StaticCase = {
  id: string;
  route: string;
  view: StaticCaseView;
  width: number;
  height: number;
};

export type Shard = { index: number; count: number };

export function isComponentRoute(route: string): boolean {
  return /^\/page\/[^/]+$/.test(route);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function caseId(route: string, view: StaticCaseView, width: number): string {
  return `${route} ${view} ${width}px`;
}

export function createCaseList(routes: readonly string[]): StaticCase[] {
  const cases: StaticCase[] = [];
  for (const route of new Set(routes)) {
    const views: StaticCaseView[] = isComponentRoute(route)
      ? ['documentation', 'playground']
      : ['page'];
    for (const view of views) {
      for (const { width, height } of STATIC_VIEWPORTS) {
        cases.push({ id: caseId(route, view, width), route, view, width, height });
      }
    }
  }
  const routeSet = new Set(routes);
  if (IN_PLACE_NAVIGATION_ROUTES.every((route) => routeSet.has(route))) {
    const [{ width, height }] = STATIC_VIEWPORTS;
    cases.push({
      id: IN_PLACE_NAVIGATION_CASE_ID,
      route: IN_PLACE_NAVIGATION_ROUTES[0],
      view: 'navigation',
      width,
      height,
    });
  }
  return cases.toSorted((left, right) => compareCodeUnits(left.id, right.id));
}

export function parseShard(value: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || count < 1 || index < 1 || index > count) {
    throw new Error(`[static-playground] --shard must be <index>/<count> with 1 <= index <= count`);
  }
  return { index, count };
}

export function selectShard(cases: readonly StaticCase[], shard: Shard): StaticCase[] {
  return cases.filter((_testCase, position) => position % shard.count === shard.index - 1);
}
