<script lang="ts">
  import { onMount } from 'svelte';

  import { Button, VideoPlayer } from '@lostgradient/cinder';

  // Silent 8 kHz mono PCM, served as a blob: URL so the fixture needs no network.
  function silentWavUrl(seconds: number): string {
    const sampleRate = 8000;
    const samples = sampleRate * seconds;
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

  function clock(seconds: number): string {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  // The Readyset review board: three comments on a 48-second walkthrough, its chapters, and the
  // position held at 0:19 for the comment action.
  const reviewMarkers = [
    { time: 8, badge: '1', label: 'Comment 1 at 0:08' },
    { time: 19, badge: '2', label: 'Comment 2 at 0:19' },
    { time: 33, badge: '3', label: 'Comment 3 at 0:33' },
  ];

  const reviewChapters = [
    { time: 0, title: 'Open board' },
    { time: 12, title: 'Add card' },
    { time: 30, title: 'Move card' },
  ];

  // Two comments a second apart: the spec widens this player so they sit ten pixels apart.
  const closeMarkers = [
    { time: 20, badge: '1', label: 'Comment 1 at 0:20' },
    { time: 21, badge: '2', label: 'Comment 2 at 0:21' },
  ];

  let source = $state<string | undefined>(undefined);
  let reviewSource = $state<string | undefined>(undefined);
  let reviewTime = $state(19);

  onMount(() => {
    const url = silentWavUrl(4);
    const reviewUrl = silentWavUrl(48);
    source = url;
    reviewSource = reviewUrl;
    return () => {
      URL.revokeObjectURL(url);
      URL.revokeObjectURL(reviewUrl);
    };
  });
</script>

{#if source !== undefined}
  <div data-testid="video-player-playable">
    <VideoPlayer src={source} label="Fixture clip" />
  </div>
{/if}

{#if reviewSource !== undefined}
  <div data-testid="video-player-review">
    <VideoPlayer
      src={reviewSource}
      label="Walkthrough recording"
      markers={reviewMarkers}
      chapters={reviewChapters}
      bind:currentTime={reviewTime}
    >
      {#snippet actions({ currentTime })}
        <Button size="sm">Comment at {clock(currentTime)}</Button>
      {/snippet}
    </VideoPlayer>
  </div>

  <div data-testid="video-player-close-markers">
    <VideoPlayer src={reviewSource} label="Close comments" markers={closeMarkers} />
  </div>
{/if}

<div data-testid="video-player-blocked">
  <VideoPlayer src="javascript:void(0)" label="Blocked clip" />
</div>
