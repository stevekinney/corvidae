<script lang="ts">
  import { LocaleProvider } from '@lostgradient/locale-provider/components/locale-provider/index.ts';
  import { NumberInput } from '@lostgradient/number-input/components/number-input/index.ts';
  import { PhoneInput } from '../../components/phone-input/index.ts';
  import { Slider } from '@lostgradient/slider/components/slider/index.ts';
  import { Statistic } from '../../components/statistic/index.ts';
  import type { TextDirection } from '@lostgradient/locale-provider/components/locale-provider/index.ts';

  let {
    locale = 'de-DE',
    direction,
    nestedDirection,
    explicitStatisticLocale,
    explicitNumberLocale,
    explicitPhoneLocale,
  }: {
    locale?: string;
    direction?: TextDirection;
    nestedDirection?: TextDirection;
    explicitStatisticLocale?: string;
    explicitNumberLocale?: string;
    explicitPhoneLocale?: string;
  } = $props();

  const statLocaleProps = $derived(
    explicitStatisticLocale === undefined ? {} : { valueLocale: explicitStatisticLocale },
  );
  const numberLocaleProps = $derived(
    explicitNumberLocale === undefined ? {} : { locale: explicitNumberLocale },
  );
  const phoneLocaleProps = $derived(
    explicitPhoneLocale === undefined ? {} : { locale: explicitPhoneLocale },
  );
</script>

{#snippet controls()}
  <Statistic label="Revenue" value={1234.5} {...statLocaleProps} />
  <NumberInput id="localized-number" label="Amount" value={1234.5} {...numberLocaleProps} />
  <PhoneInput id="localized-phone" label="Phone" countries={['US']} {...phoneLocaleProps} />
  <Slider label="Progress" value={25} />
{/snippet}

<LocaleProvider {locale} {direction}>
  {#if nestedDirection}
    <LocaleProvider direction={nestedDirection}>
      {@render controls()}
    </LocaleProvider>
  {:else}
    {@render controls()}
  {/if}
</LocaleProvider>
