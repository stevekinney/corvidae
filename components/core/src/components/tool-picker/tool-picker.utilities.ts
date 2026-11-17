import type { ToolPickerGroup, ToolPickerItem } from './tool-picker.types.ts';

/** A group of items as the picker lists it. */
export type ToolPickerSection = {
  /** The group's name. */
  name: string;
  /** Words after the count on the header, for a group nothing can be chosen from. */
  note: string | undefined;
  /** The group's items, in the order given. */
  items: ToolPickerItem[];
};

/** Whether the person can choose `item`. */
export function isSelectable(item: ToolPickerItem): boolean {
  return item.selectable !== false;
}

/**
 * The groups the picker lists: the named ones first, in the order given, then any group an item
 * names that was not listed, in order of first appearance. A group with no item is left out.
 */
export function buildSections(
  items: readonly ToolPickerItem[],
  groups: readonly ToolPickerGroup[] | undefined,
): ToolPickerSection[] {
  const sections = new Map<string, ToolPickerSection>();
  for (const group of groups ?? []) {
    if (!sections.has(group.name)) {
      sections.set(group.name, { name: group.name, note: group.note, items: [] });
    }
  }
  for (const item of items) {
    let section = sections.get(item.group);
    if (section === undefined) {
      section = { name: item.group, note: undefined, items: [] };
      sections.set(item.group, section);
    }
    section.items.push(item);
  }
  return [...sections.values()].filter((section) => section.items.length > 0);
}

/**
 * Whether `item` answers what was typed: every word matches its name, identifier, suffix or
 * description, ignoring case. An empty search matches everything.
 */
export function matchesQuery(item: ToolPickerItem, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.label, item.code, item.suffix, item.description]
    .filter((part): part is string => part !== undefined)
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** How many of a section's items are in `chosen`. */
export function chosenCount(section: ToolPickerSection, chosen: ReadonlySet<string>): number {
  return section.items.filter((item) => isSelectable(item) && chosen.has(item.value)).length;
}

/**
 * The chosen values in the order of `items`, followed by any value of `previous` that no item
 * names, so a choice the list no longer offers is not silently dropped.
 */
export function orderChosen(
  items: readonly ToolPickerItem[],
  chosen: ReadonlySet<string>,
  previous: readonly string[],
): string[] {
  const known = new Set(items.map((item) => item.value));
  const listed = items
    .filter((item) => isSelectable(item) && chosen.has(item.value))
    .map((item) => item.value);
  return [...listed, ...previous.filter((value) => !known.has(value) && chosen.has(value))];
}
