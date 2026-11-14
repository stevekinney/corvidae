<script lang="ts">
  import PhoneInput from './phone-input.svelte';
</script>

<!-- PhoneInput's country control at its content width, in every state and in a narrow
     container, measured in a browser. -->
<div class="phone-input-sizing">
  <div data-testid="default">
    <PhoneInput id="sizing-default" label="Phone" value="+14155550132" />
  </div>
  <div data-testid="long-code">
    <PhoneInput id="sizing-long-code" label="Long dial code" country="FI" />
  </div>
  <div data-testid="american-samoa">
    <PhoneInput id="sizing-american-samoa" label="American Samoa" country="AS" />
  </div>
  <div data-testid="disabled">
    <PhoneInput id="sizing-disabled" label="Disabled" disabled value="+14155550132" />
  </div>
  <div data-testid="invalid">
    <PhoneInput id="sizing-invalid" label="Invalid" value="555" error="Enter a complete number." />
  </div>
  <div class="phone-input-sizing__narrow" data-testid="narrow">
    <PhoneInput id="sizing-narrow" label="Narrow" value="+14155550132" />
  </div>
  <!-- A right-to-left page names its language: Bun's CSS bundler keys logical insets on
       `:lang()`. -->
  <div dir="rtl" lang="ar" data-testid="rtl">
    <PhoneInput id="sizing-rtl" label="RTL" value="+14155550132" />
  </div>
</div>

<style>
  .phone-input-sizing {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
    max-inline-size: 28rem;
  }

  .phone-input-sizing__narrow {
    inline-size: 15rem;
  }
</style>
