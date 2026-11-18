/**
 * The component sweep of every fixture this package owns (COR-2092): both themes, every viewport,
 * a screenshot against the package's own browser snapshots and the accessibility gate.
 */
import { defineComponentSweep } from '@lostgradient/testing/playwright/component-sweep-suite';

defineComponentSweep();
