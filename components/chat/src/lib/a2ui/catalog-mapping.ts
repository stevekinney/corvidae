/**
 * How each A2UI v0.9.1 basic-catalog component maps onto Cinder, and every
 * enumerated property value with it.
 *
 * Each enumerated property lists every value the catalog allows, and its
 * default. A value the table does not list (a newer catalog's, or a malformed
 * one) maps to the default and reports one `unsupported-value` diagnostic; a
 * test walks the vendored catalog and fails on any value missing here.
 */

/** The Cinder component (or components) a basic-catalog component renders with. */
export const A2UI_COMPONENT_TARGETS = {
  Text: 'text',
  Image: 'image',
  Icon: 'icons',
  Video: 'video-player',
  AudioPlayer: 'audio-player',
  Row: 'stack',
  Column: 'stack',
  List: 'stack in scroll-area',
  Card: 'card',
  Tabs: 'tabs',
  Divider: 'divider',
  Modal: 'modal',
  Button: 'button',
  TextField: 'input, textarea, or number-input',
  CheckBox: 'checkbox',
  ChoicePicker: 'checkbox-group, multi-select, radio-group, select, or combobox',
  Slider: 'slider',
  DateTimeInput: 'date-picker or time-field',
} as const;

/** A basic-catalog component type. */
export type A2uiBasicComponent = keyof typeof A2UI_COMPONENT_TARGETS;

/** True for a component type the basic catalog defines. */
export function isBasicComponent(type: string): type is A2uiBasicComponent {
  return Object.hasOwn(A2UI_COMPONENT_TARGETS, type);
}

/** One enumerated property: each catalog value's Cinder value, and the default. */
type EnumMapping<T extends string> = {
  readonly values: Readonly<Record<string, T>>;
  readonly default: string;
};

const justify = {
  values: {
    start: 'start',
    center: 'center',
    end: 'end',
    spaceBetween: 'between',
    spaceAround: 'around',
    spaceEvenly: 'evenly',
    stretch: 'start',
  },
  default: 'start',
} as const satisfies EnumMapping<string>;

const align = {
  values: {
    start: 'start',
    center: 'center',
    end: 'end',
    stretch: 'stretch',
    baseline: 'baseline',
  },
  default: 'stretch',
} as const satisfies EnumMapping<string>;

/** Every enumerated property of every component, mapped. */
export const A2UI_ENUM_MAPPINGS = {
  Text: {
    variant: {
      values: {
        h1: 'h1',
        h2: 'h2',
        h3: 'h3',
        h4: 'h4',
        h5: 'h5',
        caption: 'caption',
        body: 'body',
      },
      default: 'body',
    },
  },
  Image: {
    fit: {
      values: {
        contain: 'contain',
        cover: 'cover',
        fill: 'fill',
        none: 'none',
        scaleDown: 'scale-down',
      },
      default: 'fill',
    },
    variant: {
      values: {
        icon: 'icon',
        avatar: 'avatar',
        smallFeature: 'small',
        mediumFeature: 'medium',
        largeFeature: 'large',
        header: 'header',
      },
      default: 'mediumFeature',
    },
  },
  Row: { justify, align },
  Column: { justify, align },
  List: {
    direction: { values: { vertical: 'vertical', horizontal: 'horizontal' }, default: 'vertical' },
    align,
  },
  Divider: {
    axis: { values: { horizontal: 'horizontal', vertical: 'vertical' }, default: 'horizontal' },
  },
  Button: {
    variant: {
      values: { default: 'secondary', primary: 'primary', borderless: 'ghost' },
      default: 'default',
    },
  },
  TextField: {
    variant: {
      values: {
        shortText: 'input',
        longText: 'textarea',
        number: 'number-input',
        obscured: 'password',
      },
      default: 'shortText',
    },
  },
  ChoicePicker: {
    variant: {
      values: { multipleSelection: 'multiple', mutuallyExclusive: 'single' },
      default: 'mutuallyExclusive',
    },
    displayStyle: { values: { checkbox: 'checkbox', chips: 'chips' }, default: 'checkbox' },
  },
} as const satisfies Partial<
  Record<A2uiBasicComponent, Readonly<Record<string, EnumMapping<string>>>>
>;

/**
 * Maps one enumerated property through its entry in {@link A2UI_ENUM_MAPPINGS}.
 * An absent value maps to the default quietly; a value the table does not list
 * maps to the default and is reported.
 */
export function mapEnum<V extends string>(
  mapping: { readonly values: Readonly<Record<string, V>>; readonly default: string },
  label: string,
  value: unknown,
  report: (message: string) => void,
): V {
  const fallback = mapping.values[mapping.default];
  if (fallback === undefined) throw new Error(`${label} has no mapping for its default`);
  if (typeof value === 'string' && Object.hasOwn(mapping.values, value)) {
    return mapping.values[value] ?? fallback;
  }
  if (value !== undefined && value !== null) {
    report(`${label} ${JSON.stringify(value)} is not supported; using "${mapping.default}"`);
  }
  return fallback;
}

/**
 * The Cinder control a ChoicePicker renders as. Multiple selection is a
 * checkbox group, or a multi-select for chips or a filterable list; single
 * selection is a radio group, a select for chips, or a combobox when it is
 * filterable.
 */
export function choicePickerControl(
  selection: 'multiple' | 'single',
  displayStyle: 'checkbox' | 'chips',
  filterable: boolean,
): 'checkbox-group' | 'multi-select' | 'radio-group' | 'select' | 'combobox' {
  if (selection === 'multiple') {
    return displayStyle === 'checkbox' && !filterable ? 'checkbox-group' : 'multi-select';
  }
  if (filterable) return 'combobox';
  return displayStyle === 'checkbox' ? 'radio-group' : 'select';
}

/**
 * The Cinder control a DateTimeInput renders as, or `none` when it enables
 * neither a date nor a time (both default to false), so there is nothing to pick.
 */
export function dateTimeControl(
  enableDate: boolean,
  enableTime: boolean,
):
  | { readonly control: 'date-picker'; readonly granularity: 'day' | 'minute' }
  | { readonly control: 'time-field' }
  | { readonly control: 'none' } {
  if (!enableDate && !enableTime) return { control: 'none' };
  if (enableTime && !enableDate) return { control: 'time-field' };
  return { control: 'date-picker', granularity: enableTime ? 'minute' : 'day' };
}
