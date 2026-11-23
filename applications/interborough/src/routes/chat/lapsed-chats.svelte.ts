/**
 * The chats whose open page has found that nothing waits on their approval any more (COR-2438): a
 * decision was refused because no approval waits, so the page draws the call as no longer waiting,
 * though the Bureau may still list the chat as parked on input and hold its review as pending. The
 * chat list reads this beside the pending reviews, so the list's status and the open chat's agree
 * after the re-read. An entry lasts while that page is open and its approval stays lapsed: a later
 * read that lists the call waiting again, or closing the chat, gives the Bureau's word back.
 */
import { SvelteSet } from 'svelte/reactivity';

export const lapsedChats = new SvelteSet<string>();
