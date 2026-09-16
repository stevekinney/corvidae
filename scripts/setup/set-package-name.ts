#!/usr/bin/env bun
import path from 'node:path';

import chalk from 'chalk';
import { kebabCase } from 'change-case';

// Use import.meta.dir for reliable path resolution during bun create
const setupDir = import.meta.dir;
const projectRoot = path.dirname(path.dirname(setupDir)); // scripts/setup -> scripts -> project
const directoryName = path.basename(projectRoot);
const packagePath = path.join(projectRoot, 'package.json');

const projectName = kebabCase(directoryName.replace(/^\.+/, '') || 'project-name');

try {
  const raw = await Bun.file(packagePath).text();
  const pkg = JSON.parse(raw);
  pkg.packageManager = `bun@${Bun.version}`;

  if (pkg.name !== projectName) {
    pkg.name = projectName;
    console.log(chalk.green(`Updated package name to "${projectName}".`));
  } else {
    console.log(chalk.gray('Package name already up to date.'));
  }
  await Bun.write(packagePath, JSON.stringify(pkg, null, 2) + '\n');
} catch (err) {
  console.error(chalk.red('Failed to update package name:'), err);
  process.exit(1);
}
