/** Shared fixtures for `<RefreshPanel>`'s component tests (COR-166). */
import { render } from '@testing-library/svelte';

import ToastHost from '../../app/toast-host.svelte';
import { createQueryClient } from '../../lib/query.ts';
import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
import RefreshPanelFixture from './refresh-panel-fixture.test-harness.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient } from './system-test-support.test-support.ts';

export const DIAGNOSTICS_METHOD = 'weft.workflows.refresh.diagnostics';
export const REFRESH_METHOD = 'weft.workflows.refresh';

/** A checked source whose candidate (rev-2) is installed beside the active revision (rev-1). */
export function installedSource(overrides: Record<string, unknown> = {}) {
  return {
    name: 'order-processing',
    state: 'installed',
    etag: 'sha256:etag-2',
    checkedAt: 1_700_000_000_000,
    candidate: { revision: 'rev-2', digest: 'sha256:digest-2', contractHash: 'sha256:contract-2' },
    current: {
      revision: 'rev-1',
      generation: 3,
      contractHash: 'sha256:contract-1',
      digest: 'sha256:digest-1',
    },
    ...overrides,
  };
}

export function renderRefreshPanel(principalScopes?: readonly AuthorizationScope[]) {
  render(ToastHost);
  return render(SystemRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: RefreshPanelFixture,
      ...(principalScopes === undefined ? {} : { principalScopes }),
    },
  });
}
