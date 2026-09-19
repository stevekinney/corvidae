<script lang="ts">
  import { SourceDiffViewer } from '@corvidae/cinder';

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
</script>

<SourceDiffViewer {patch} />
