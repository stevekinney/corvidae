import { test as nodeTest } from 'node:test';
import { runRuntimeSmoke } from './runtime-smoke.ts';
nodeTest('memory smoke', runRuntimeSmoke);
