import { BrowserView, BrowserWindow, Updater } from 'electrobun/main';

import { createChatRuns } from './chat/chat-runs.ts';

import {
  applicationRpcContract,
  type ApplicationRPCSchema,
  type ApplicationWebviewMessageSender,
} from '../shared/rpc-contract.ts';
import { createValidatedRequestHandlers } from '../shared/rpc-validation.ts';

const DEVELOPMENT_SERVER_URL = 'http://localhost:5173';

/**
 * Prefers the Vite dev server when one is listening, so `hutch run dev:hmr`
 * gives the renderer hot module replacement. Every other case loads the copy
 * packaged into the bundle.
 *
 * The probe is a real request rather than a channel check alone: the dev
 * channel is also what a plain `electrobun dev` uses, and pointing the window
 * at a server that is not running would open an empty window instead of the
 * application.
 */
async function resolveMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel !== 'dev') return 'views://mainview/index.html';
  try {
    await fetch(DEVELOPMENT_SERVER_URL, { method: 'HEAD' });
    return DEVELOPMENT_SERVER_URL;
  } catch {
    return 'views://mainview/index.html';
  }
}

const url = await resolveMainViewUrl();

/*
 * The handlers need a sender and the sender only exists once the RPC is
 * constructed, which needs the handlers. This indirection breaks that cycle:
 * `rpc` is assigned synchronously below, long before a renderer request can
 * arrive, so a send that found it unset would mean a frame produced before the
 * window existed.
 */
let rpc: ReturnType<typeof BrowserView.defineRPC<ApplicationRPCSchema>> | undefined;
const send: ApplicationWebviewMessageSender = {
  chatStreamLine: (payload) => rpc?.send.chatStreamLine(payload),
  chatStreamEnd: (payload) => rpc?.send.chatStreamEnd(payload),
};

const chatRuns = createChatRuns(send);

rpc = BrowserView.defineRPC<ApplicationRPCSchema>({
  handlers: {
    requests: createValidatedRequestHandlers(applicationRpcContract.bun, {
      startChatRun: ({ runId, conversation }) => chatRuns.start({ runId, conversation }),
      abortChatRun: ({ runId }) => ({ aborted: chatRuns.abort(runId) }),
    }),
    messages: {},
  },
});

const mainWindow = new BrowserWindow({
  title: 'Corvidae Desktop',
  url,
  frame: { width: 960, height: 720, x: 200, y: 200 },
  rpc,
});

// A closed window has nobody left to stream to, but the provider request is
// already open and still billing. Abort in-flight runs rather than letting
// them finish into a renderer that is gone.
mainWindow.on('close', () => {
  chatRuns.abortAll();
});
