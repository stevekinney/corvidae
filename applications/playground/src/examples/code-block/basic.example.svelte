<script lang="ts" module>
  export const title = 'Basic code block';
  export const description = 'Multi-line preformatted code.';
</script>

<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder';
  const code = `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const message = greet('world');`;
</script>

<CodeBlock {code} />
