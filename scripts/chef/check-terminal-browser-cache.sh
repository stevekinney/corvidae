#!/usr/bin/env bash
set -eo pipefail
bunx turbo run test:browser --filter=@lostgradient/terminal --dry=json |
  bun -e 'const run = JSON.parse(await Bun.stdin.text()); const task = run.tasks.find((entry) => entry.taskId === "@lostgradient/terminal#test:browser"); console.log("terminal test:browser cache: " + task?.cache?.status); if (task?.cache?.status !== "HIT") process.exit(1);'
