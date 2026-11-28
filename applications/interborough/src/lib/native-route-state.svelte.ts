import type { ApplicationState } from '@lostgradient/velveteen/navigation';
import { routes, velveteenRouteId } from '../app/routes.ts';
import { identifierViewKey, withEscapedIdentifier } from './identifier-paths.ts';

function readLocation(
  location: NavigationState['page']['payload'] | NonNullable<ApplicationState['shallow']>,
  restoredFromDocument: boolean,
) {
  const url = new URL(location.url);
  const definition =
    location.routeId === null
      ? undefined
      : routes.find((route) => velveteenRouteId(route.pattern) === location.routeId);
  const params = Object.fromEntries(
    Object.entries(location.params).map(([name, value]) => [
      name === 'path' ? '*' : name,
      restoredFromDocument ? decodeURIComponent(String(value)) : String(value),
    ]),
  );
  return { url, definition, params };
}

/** Project native navigation into the app's existing layout and identifier metadata. */
type NavigationState = Pick<ApplicationState, 'registerNavigationHook'> & {
  shallow?: ApplicationState['shallow'];
  page: { payload: Pick<ApplicationState['page']['payload'], 'url' | 'params' | 'routeId'> };
  navigation?: Pick<NonNullable<ApplicationState['navigation']>, 'goto'>;
};

export function bindNativeRouteState(
  state: NavigationState,
  allowsLeaving: (destination: string) => boolean,
) {
  const { navigation, registerNavigationHook } = state;
  if (navigation === undefined || registerNavigationHook === undefined)
    throw new Error('Native document navigation is unavailable');
  const renderedKey = () => {
    const { url, definition, params } = readLocation(state.page.payload, true);
    return identifierViewKey(
      url.pathname,
      definition === undefined ? null : { definition, params },
      url.searchParams,
    );
  };
  let generation = $state(0);
  let retainedKey: string | undefined;
  let forced = false;
  const removeBefore = registerNavigationHook('before', (event) => {
    if (!forced && !allowsLeaving(event.to.pathname + event.to.search)) event.cancel();
  });
  const removeAfter = registerNavigationHook('after', () => {
    if (state.shallow !== undefined) {
      retainedKey ??= renderedKey();
      return;
    }
    if (retainedKey !== undefined && retainedKey === renderedKey()) generation += 1;
    retainedKey = undefined;
  });
  return {
    get url() {
      return new URL(state.shallow?.url ?? state.page.payload.url);
    },
    get viewKey() {
      const key = renderedKey();
      return generation === 0 ? key : `${key}\u0000${generation}`;
    },
    get match() {
      const { definition, params } = readLocation(
        state.shallow ?? state.page.payload,
        state.shallow === undefined,
      );
      return definition === undefined ? null : { pattern: definition.pattern, params };
    },
    get current() {
      const { url, definition, params } = readLocation(
        state.shallow ?? state.page.payload,
        state.shallow === undefined,
      );
      return {
        route: definition ?? null,
        params:
          definition === undefined
            ? {}
            : withEscapedIdentifier({ definition, params }, url.searchParams),
        search: url.searchParams,
      };
    },
    navigate(
      path: string,
      options?: { readonly replace?: boolean; readonly keep?: boolean; readonly force?: boolean },
    ) {
      forced = options?.force === true;
      try {
        return navigation.goto(path, {
          replace: options?.replace === true,
          shallow: options?.keep === true,
        });
      } finally {
        forced = false;
      }
    },
    dispose() {
      removeBefore();
      removeAfter();
    },
  };
}
