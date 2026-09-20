<script lang="ts">
  import { DiffViewer } from '@corvidae/editor';
  import { Button } from '@corvidae/cinder';

  type DiffViewerFixtureWindow = Window &
    typeof globalThis & {
      __diffViewerActionCount?: number;
      __diffViewerRevertAllCount?: number;
    };

  const editable = new URLSearchParams(globalThis.location.search).get('editable') === '1';

  function incrementWindowCounter(key: '__diffViewerActionCount' | '__diffViewerRevertAllCount') {
    const state = window as DiffViewerFixtureWindow;
    state[key] = (state[key] ?? 0) + 1;
  }

  function handleNamedAction() {
    incrementWindowCounter('__diffViewerActionCount');
  }

  function handleRevertAll() {
    incrementWindowCounter('__diffViewerRevertAllCount');
  }

  const original = `---
title: Project Plan
status: draft
owner: docs
---

# Project Plan

The first version includes authentication, a dashboard, and export tools.

## Tasks

- Build login
- Add dashboard
- Ship PDF export`;

  const current = `---
title: Project Plan
status: published
owner: editorial
---

# Project Plan

The first version includes authentication, a dashboard, and CSV export tools.

## Tasks

- Build login
- Add dashboard metrics
- Ship CSV export
- Add audit logging`;
</script>

<DiffViewer {original} {current} readonly={!editable} onrevertall={handleRevertAll}>
  {#snippet toolbarActions()}
    {#if editable}
      <Button variant="secondary" size="xs" onclick={handleNamedAction}>Mark reviewed</Button>
    {/if}
  {/snippet}
</DiffViewer>
