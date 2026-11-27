/// <reference lib="webworker" />
import {
  NODE_RUNTIME_WORKFLOW_NAME,
  nodeRuntimeActivityHandler,
} from './node-runtime-activity-handler.fixture.ts';
import { initializeRevisionRealmWorker } from './revision-realm-generator-worker-entry.ts';

initializeRevisionRealmWorker({ [NODE_RUNTIME_WORKFLOW_NAME]: nodeRuntimeActivityHandler });
