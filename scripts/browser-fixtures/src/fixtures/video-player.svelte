<script lang="ts">
  import { onMount } from 'svelte';

  import { VideoPlayer } from '@lostgradient/cinder';

  // Four seconds of silent 8 kHz mono PCM, served as a blob: URL so the fixture needs no network.
  function silentWavUrl(): string {
    const sampleRate = 8000;
    const samples = sampleRate * 4;
    const buffer = new ArrayBuffer(44 + samples);
    const view = new DataView(buffer);
    const write = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index));
      }
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    write(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    write(36, 'data');
    view.setUint32(40, samples, true);
    new Uint8Array(buffer, 44).fill(128);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  let source = $state<string | undefined>(undefined);

  onMount(() => {
    const url = silentWavUrl();
    source = url;
    return () => URL.revokeObjectURL(url);
  });
</script>

{#if source !== undefined}
  <div data-testid="video-player-playable">
    <VideoPlayer src={source} label="Fixture clip" />
  </div>
{/if}

<div data-testid="video-player-blocked">
  <VideoPlayer src="javascript:void(0)" label="Blocked clip" />
</div>
