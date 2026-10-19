/**
 * The agent a new chat talks to unless `?agent=` names another: the one the host seeds as its
 * plain conversational agent (`src/host/seed.ts`). A new chat never shows the agents as a row of
 * buttons to pick from; this one receives it, and a searchable list changes the choice.
 */
export const DEFAULT_AGENT = 'assistant';
