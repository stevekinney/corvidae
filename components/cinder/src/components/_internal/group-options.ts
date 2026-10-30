/**
 * One member of an option section: the option and its position in the flat,
 * display-ordered list that keyboard navigation and option ids are built from.
 */
export type OptionSectionMember<O> = {
  /** The option itself. */
  option: O;
  /** Index of the option in the flat, display-ordered list. */
  index: number;
};

/**
 * A run of options that render under one heading, or the leading run of
 * options that have no group.
 */
export type OptionSection<O> = {
  /** Group name shown in the heading, or `undefined` for the leading ungrouped section. */
  group: string | undefined;
  /** Position of this section among the rendered sections, stable enough to seed an element id. */
  sectionIndex: number;
  /** The options in this section, in display order. */
  members: OptionSectionMember<O>[];
};

/** Options flattened into display order, plus the sections that order was built from. */
export type GroupedOptions<O> = {
  /** The options in display order: ungrouped first, then each group in order of first appearance. */
  ordered: O[];
  /** The same options split into sections. */
  sections: OptionSection<O>[];
};

/** The trimmed group name, or `undefined` when the option has none (absent, empty or blank). */
function normalizeGroup(group: string | undefined): string | undefined {
  const trimmed = group?.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether any option carries a non-blank group name. */
export function hasGroupedOptions<O>(
  options: readonly O[],
  groupOf: (option: O) => string | undefined,
): boolean {
  return options.some((option) => normalizeGroup(groupOf(option)) !== undefined);
}

/**
 * Splits options into display sections: ungrouped options first without a
 * heading, then one section per group in order of first appearance, each
 * keeping its options in their original relative order. Options of one group
 * that were interleaved with another group's in the input are gathered together.
 *
 * The flat `ordered` list is the single source of truth for the picker's
 * option ids, active-option tracking and keyboard navigation, so the DOM order
 * of the rendered options always equals `ordered`.
 */
export function groupOptions<O>(
  options: readonly O[],
  groupOf: (option: O) => string | undefined,
): GroupedOptions<O> {
  const ungrouped: O[] = [];
  const groups = new Map<string, O[]>();
  for (const option of options) {
    const group = normalizeGroup(groupOf(option));
    if (group === undefined) {
      ungrouped.push(option);
      continue;
    }
    const members = groups.get(group);
    if (members) members.push(option);
    else groups.set(group, [option]);
  }

  const ordered: O[] = [];
  const sections: OptionSection<O>[] = [];
  const addSection = (group: string | undefined, section: O[]): void => {
    const members = section.map((option, offset) => ({ option, index: ordered.length + offset }));
    sections.push({ group, sectionIndex: sections.length, members });
    ordered.push(...section);
  };
  if (ungrouped.length > 0) addSection(undefined, ungrouped);
  for (const [group, section] of groups) addSection(group, section);
  return { ordered, sections };
}
