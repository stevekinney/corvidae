<script lang="ts">
  import { default as CodeBlock } from '@lostgradient/code-block/components/code-block/index.ts';
  const code = `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const message = greet('world');`;
</script>

<CodeBlock {code} />
