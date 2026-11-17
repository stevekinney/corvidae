<script lang="ts" module>
  export const title = 'Optional annotation hooks';
  export const description =
    'A controlled annotationSelection lets a host build line-comment UI without SourceDiffViewer importing editor or Markdown runtime code.';
</script>

<script lang="ts">
  import { SourceDiffViewer, type SourceDiffAnnotationSelection } from '@lostgradient/cinder';

  const patch = `diff --git a/src/cache.ts b/src/cache.ts
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -1,2 +1,2 @@
-cache.set(key, result);
+cache.set(key, result, { ttl: 60 });
 return result;
`;

  let selection: SourceDiffAnnotationSelection | null = $state(null);
</script>

<SourceDiffViewer
  {patch}
  annotationSelection={selection}
  onAnnotationSelectionChange={(next) => (selection = next)}
/>
