<script lang="ts">
  import { A2uiSurface, type A2uiAction, type A2uiComponent } from '@lostgradient/chat';

  import part from './a2ui-a2a-part.golden.json';

  // The A2A `application/a2ui+json` data part Bureau sends for a task's surface, checked in as a
  // golden file that Bureau's own test regenerates and compares. A host reads the part the way
  // this fixture does: the messages rebuild the surface, the metadata names it and its revision.
  type Message = {
    updateComponents?: { components: A2uiComponent[] };
    updateDataModel?: { path: string; value: unknown };
  };
  const messages = part.data as Message[];
  const components = messages.flatMap((message) => message.updateComponents?.components ?? []);
  const dataModel = messages.find((message) => message.updateDataModel?.path === '/')
    ?.updateDataModel?.value as Record<string, never> | undefined;

  let sent = $state<string>('');
  // What a host sends back: the action, and the revision it was taken on as the metadata key
  // Bureau reads (`a2uiSurfaceRevision`).
  function onAction(action: A2uiAction): void {
    sent = JSON.stringify({
      name: action.name,
      surfaceId: action.surfaceId,
      context: action.context,
      metadata: { a2uiSurfaceRevision: action.surfaceRevision },
    });
  }
</script>

<div id="fixture-a2ui-a2a-part" style="max-inline-size: 32rem;">
  <A2uiSurface
    surfaceId={part.metadata.surfaceId}
    surfaceRevision={part.metadata.a2uiSurfaceRevision}
    {components}
    {dataModel}
    {onAction}
  />
  <output data-testid="a2ui-sent">{sent}</output>
</div>
