<script lang="ts">
  import { SourceDiffViewer, type SourceDiffAnnotationSelection } from '@lostgradient/cinder';

  const patch = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,5 @@
 export function greet(name: string) {
-  return \`Hello, \${name}.\`;
+  const normalizedName = name.trim();
+  return \`Hello, \${normalizedName}.\`;
 }
`;

  let firstSelection: SourceDiffAnnotationSelection | null = $state(null);
  let secondSelection: SourceDiffAnnotationSelection | null = $state(null);
</script>

<div id="example-mount-default">
  <SourceDiffViewer {patch} />
</div>

<div id="example-mount-annotation-first">
  <SourceDiffViewer
    {patch}
    ariaLabel="First diff review"
    annotationSelection={firstSelection}
    onAnnotationSelectionChange={(next) => (firstSelection = next)}
  />
  <output id="annotation-first-result">{JSON.stringify(firstSelection)}</output>
</div>

<div id="example-mount-annotation-second">
  <SourceDiffViewer
    {patch}
    ariaLabel="Second diff review"
    annotationSelection={secondSelection}
    onAnnotationSelectionChange={(next) => (secondSelection = next)}
  />
  <output id="annotation-second-result">{JSON.stringify(secondSelection)}</output>
</div>
