/** Audit the virtual-list source graph for forbidden or undeclared runtime dependencies. */
import {
  collectScanTargets,
  loadDeclaredDependencyNames,
  walkDependencyGraph,
} from './check-virtual-list-dependency-free-graph.ts';

async function main(): Promise<void> {
  const declaredDependencyNames = await loadDeclaredDependencyNames();
  const rootFilePaths = await collectScanTargets();
  const { violations, scannedFilePaths } = await walkDependencyGraph(
    rootFilePaths,
    declaredDependencyNames,
  );

  if (violations.length === 0) {
    process.stdout.write(
      `check-virtual-list-dependency-free — OK (${scannedFilePaths.length} files, no ` +
        '@tanstack/virtual-core or undeclared bare imports).\n',
    );
    return;
  }

  process.stderr.write(
    'check-virtual-list-dependency-free — forbidden imports detected.\n' +
      'components/cinder/src/components/virtual-list/** and fixed-virtual-window.ts must never ' +
      'import `@tanstack/virtual-core`, and every other bare import must already be declared in ' +
      "components/cinder/package.json's `dependencies`. Use a relative import, or add the " +
      'package to `dependencies` if this is a deliberate, reviewed addition.\n\n',
  );
  for (const violation of violations) {
    process.stderr.write(
      `  ${violation.filePath}:${violation.lineNumber}\n` +
        `    ${violation.line}\n` +
        `    "${violation.specifier}" — ${violation.reason}\n`,
    );
  }
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-virtual-list-dependency-free failed:', error);
    process.exit(1);
  });
}
