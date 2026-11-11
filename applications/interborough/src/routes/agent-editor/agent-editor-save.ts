/**
 * How long the agent editor waits for a save's answer before it stops waiting and says it could
 * not confirm the save (board PageAppStates, row 14x): 15 seconds. The page never says saved
 * without the server's answer, so a save that times out keeps what was typed and offers Try again.
 */
export const SAVE_TIMEOUT_MS = 15_000;
