/**
 * PWA (app instalável): telas de abertura do iOS por aparelho e tema.
 * A lista espelha scripts/pwa/devices.mjs, que gera as imagens em public/pwa.
 */
const SPLASH = [
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3], [414, 896, 3], [375, 812, 3],
  [414, 896, 2], [414, 736, 3], [375, 667, 2], [320, 568, 2],
  [1024, 1366, 2], [834, 1194, 2], [820, 1180, 2], [834, 1112, 2], [810, 1080, 2], [768, 1024, 2], [744, 1133, 2],
] as const;

export const startupImages = SPLASH.flatMap(([w, h, r]) => (["dark", "light"] as const).map((theme) => ({
  url: `/pwa/splash-${w}x${h}@${r}-${theme}.png`,
  media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`,
})));
