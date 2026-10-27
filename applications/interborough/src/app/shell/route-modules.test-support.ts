/**
 * Loads every route's component once, when the route outlet's test harness is first imported.
 *
 * The outlet imports a route's component lazily, the first time a test opens its path. The first
 * test file in a run to open the runs view paid that import inside its own wait: about a second
 * under coverage on a loaded host, against `findByRole`'s one-second default, so whichever file
 * ran first failed while the same test passed alone. Loading every route here, at module scope
 * where no test's clock runs, leaves each test timing only its own rendering, whatever the file
 * order. Importing a module twice returns the one already evaluated, so the outlet's own `load()`
 * still runs and still resolves to the same component.
 */
import { routes } from '../routes.ts';

/** Every route's component, in the order of `routes`, loaded before any test imports the harness. */
export const routeComponents = await Promise.all(
  routes.map(async (route) => {
    const loaded = await route.load();
    return loaded.default;
  }),
);
