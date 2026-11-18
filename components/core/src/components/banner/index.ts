import './banner.css';
import Banner from './banner.svelte';

export default Banner;
export {
  BANNER_BACK_ONLINE_COPY,
  BANNER_MAX_ATTEMPTS,
  BANNER_PRESETS,
  bannerPresetCopy,
  formatBannerAsOf,
} from './banner-presets.ts';
export type { BannerPreset, BannerPresetCopy, BannerPresetFacts } from './banner-presets.ts';
export type { BannerProps, BannerVariant } from './banner.types.ts';
export { Banner };
