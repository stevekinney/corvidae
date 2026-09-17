<script lang="ts">
  import { Carousel } from '@repo/cinder';

  const placeholder = (hue: number) =>
    `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='600'%3E%3Crect width='1200' height='600' fill='hsl(${hue}%2C40%25%2C60%25)'/%3E%3C/svg%3E`;
  const basicSlides = [
    {
      id: 'intro',
      label: 'Introduction',
      title: 'Welcome to cinder',
      description: 'Start with the core primitives.',
      imageSrc: placeholder(220),
      imageAlt: 'Blue placeholder',
    },
    {
      id: 'patterns',
      label: 'Patterns',
      title: 'Reusable patterns',
      description: 'Build consistent experiences.',
      imageSrc: placeholder(160),
      imageAlt: 'Green placeholder',
    },
    {
      id: 'shipping',
      label: 'Shipping',
      title: 'Ship faster',
      description: 'Use robust defaults.',
      imageSrc: placeholder(290),
      imageAlt: 'Purple placeholder',
    },
  ];
  const multiSlides = Array.from({ length: 6 }, (_, index) => ({
    id: `slide-${index}`,
    label: `Slide ${index + 1}`,
    title: `Slide ${index + 1}`,
    description: 'One of several slides visible at once.',
    imageSrc: placeholder(40 + index * 45),
    imageAlt: `Placeholder ${index + 1}`,
  }));
</script>

<div class="carousel-fixture">
  <div id="example-mount-basic"><Carousel slides={basicSlides} autoplay={false} /></div>
  <div id="example-mount-multi-view">
    <Carousel
      slides={multiSlides}
      slidesPerView={1.2}
      gap="1rem"
      label="Multi-slide peek carousel"
    />
  </div>
  <button id="before-keyboard-carousel" type="button">Before keyboard carousel</button>
  <div id="example-mount-keyboard">
    <Carousel slides={basicSlides} autoplay autoplayInterval={1000} label="Keyboard examples">
      {#snippet slide(item)}
        <h3>{item.title}</h3>
        <label
          >Slide notes <input aria-label={`${item.label} notes`} value="Editable notes" /></label
        >
        <label
          >Slide volume <input aria-label={`${item.label} volume`} type="range" value="50" /></label
        >
        <a href={`#${item.id}`}>Read {item.label}</a>
      {/snippet}
    </Carousel>
  </div>
  <button id="after-keyboard-carousel" type="button">After keyboard carousel</button>
</div>
