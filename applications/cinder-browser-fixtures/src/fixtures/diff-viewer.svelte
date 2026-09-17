<script lang="ts">
  import { DiffViewer } from '@repo/editor';
  const original = `# Project Plan

The first version includes authentication, a dashboard, and export tools.

## Tasks

- Build login
- Add dashboard
- Ship PDF export`;

  const current = `# Project Plan

The first version includes authentication, a dashboard, and CSV export tools.

## Tasks

- Build login
- Add dashboard metrics
- Ship CSV export
- Add audit logging`;
</script>

<DiffViewer {original} {current} readonly />
