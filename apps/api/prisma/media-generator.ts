/**
 * Product imagery generator.
 *
 * The catalogue standard (CAT-004) demands real, consistent, portrait media
 * with alt text — and the Mini App's whole visual identity rests on product
 * imagery (§16.1: "Product media — главный визуальный контент"). A pilot
 * catalogue with broken images cannot be reviewed, and hot-linking a stock
 * photo service would make the demo depend on someone else's uptime and
 * licensing.
 *
 * So the seed renders its own: one SVG per SKU colourway, drawn as editorial
 * line-art on a studio backdrop tinted from the garment's colour family. They
 * are small, resolution-independent, self-hosted, and consistent enough to
 * read as one art direction. Replacing them with photography later is a
 * matter of pointing Media.url elsewhere.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const WIDTH = 900;
const HEIGHT = 1200;

export type GarmentShape =
  | 'coat'
  | 'blazer'
  | 'shirt'
  | 'tshirt'
  | 'blouse'
  | 'sweater'
  | 'cardigan'
  | 'hoodie'
  | 'vest'
  | 'trousers'
  | 'jeans'
  | 'skirt'
  | 'shorts'
  | 'dress'
  | 'suit'
  | 'sneaker'
  | 'loafer'
  | 'boot'
  | 'heel'
  | 'bag'
  | 'belt'
  | 'scarf'
  | 'cap';

/** Palette per colour family: the garment fill, its shadow and the backdrop. */
const PALETTE: Record<string, { base: string; shade: string; line: string; backdrop: string }> = {
  black: { base: '#232326', shade: '#131315', line: '#000000', backdrop: '#e8e6e3' },
  white: { base: '#f7f6f4', shade: '#e2e0dc', line: '#b9b5ae', backdrop: '#e4e2de' },
  cream: { base: '#f2e9da', shade: '#e3d6c0', line: '#bda98a', backdrop: '#eceadf' },
  beige: { base: '#ddcdb4', shade: '#c9b696', line: '#a3906f', backdrop: '#efe9df' },
  camel: { base: '#c89f6c', shade: '#ae8752', line: '#8a6637', backdrop: '#f0e8db' },
  brown: { base: '#75543c', shade: '#5c412d', line: '#3d2a1b', backdrop: '#ece3d8' },
  grey: { base: '#9a9a9d', shade: '#7f7f83', line: '#5c5c60', backdrop: '#eceae8' },
  navy: { base: '#262f47', shade: '#1a2134', line: '#0d1322', backdrop: '#e6e8ee' },
  blue: { base: '#3f6392', shade: '#2f4d75', line: '#1f3351', backdrop: '#e6ebf2' },
  green: { base: '#3c6b52', shade: '#2d533e', line: '#1c3728', backdrop: '#e6ede8' },
  olive: { base: '#6f7249', shade: '#585a37', line: '#3b3d22', backdrop: '#ecebe0' },
  red: { base: '#a33a35', shade: '#852c28', line: '#5d1b18', backdrop: '#f0e7e6' },
  burgundy: { base: '#6d2a35', shade: '#541f28', line: '#371218', backdrop: '#efe6e7' },
  pink: { base: '#d9a7ad', shade: '#c08d94', line: '#9b6a72', backdrop: '#f2eaea' },
  purple: { base: '#5f4b76', shade: '#4a385e', line: '#2f2240', backdrop: '#eae7ef' },
  yellow: { base: '#d6b254', shade: '#bd993d', line: '#8f7126', backdrop: '#f1ece0' },
  orange: { base: '#c47a4a', shade: '#a86238', line: '#7c4521', backdrop: '#f1e8e0' },
  silver: { base: '#c3c6cb', shade: '#a9adb4', line: '#82868d', backdrop: '#ecedef' },
  gold: { base: '#c6a35e', shade: '#ab8947', line: '#80632c', backdrop: '#f1ece0' },
  multicolor: { base: '#8c7f9c', shade: '#6f6480', line: '#4b4159', backdrop: '#ebeaee' },
  print: { base: '#9d8e7c', shade: '#847667', line: '#5d5245', backdrop: '#edeae5' },
};

function palette(colorFamily: string) {
  return PALETTE[colorFamily] ?? PALETTE.grey!;
}

/**
 * Garment line art. Coordinates are in a 900x1200 box with the garment
 * centred around x=450 and resting near y=980, so every image shares one
 * horizon and the rail reads as a set.
 */
function garment(shape: GarmentShape, colors: ReturnType<typeof palette>): string {
  const { base, shade, line } = colors;
  const stroke = `fill="none" stroke="${line}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"`;

  switch (shape) {
    case 'coat':
      return `
        <path d="M450 250 L330 300 L250 350 L220 760 L290 770 L300 980 L600 980 L610 770 L680 760 L650 350 L570 300 Z" fill="${base}"/>
        <path d="M450 250 L450 980" ${stroke}/>
        <path d="M450 250 L380 420 L330 300" fill="${shade}"/>
        <path d="M450 250 L520 420 L570 300" fill="${shade}"/>
        <path d="M220 760 L290 770 M680 760 L610 770" ${stroke}/>
        <circle cx="470" cy="470" r="9" fill="${line}" opacity="0.5"/>
        <circle cx="470" cy="580" r="9" fill="${line}" opacity="0.5"/>
        <circle cx="470" cy="690" r="9" fill="${line}" opacity="0.5"/>
        <path d="M250 600 L220 610 M650 600 L680 610" ${stroke}/>`;
    case 'blazer':
      return `
        <path d="M450 260 L340 305 L265 355 L240 700 L305 710 L312 900 L588 900 L595 710 L660 700 L635 355 L560 305 Z" fill="${base}"/>
        <path d="M450 260 L390 430 L340 305" fill="${shade}"/>
        <path d="M450 260 L510 430 L560 305" fill="${shade}"/>
        <path d="M450 430 L450 900" ${stroke}/>
        <circle cx="468" cy="560" r="8" fill="${line}" opacity="0.5"/>
        <circle cx="468" cy="640" r="8" fill="${line}" opacity="0.5"/>
        <path d="M330 700 L400 700 M570 700 L500 700" ${stroke}/>`;
    case 'suit':
      return `
        <path d="M450 240 L345 285 L275 335 L252 640 L312 650 L318 760 L582 760 L588 650 L648 640 L625 335 L555 285 Z" fill="${base}"/>
        <path d="M450 240 L395 405 L345 285" fill="${shade}"/>
        <path d="M450 240 L505 405 L555 285" fill="${shade}"/>
        <path d="M352 770 L352 1010 L424 1010 L436 790 L464 790 L476 1010 L548 1010 L548 770 Z" fill="${base}"/>
        <path d="M450 405 L450 760" ${stroke}/>`;
    case 'shirt':
      return `
        <path d="M450 265 L350 300 L272 350 L250 560 L318 575 L322 880 L578 880 L582 575 L650 560 L628 350 L550 300 Z" fill="${base}"/>
        <path d="M450 265 L408 330 L350 300 L398 268 Z" fill="${shade}"/>
        <path d="M450 265 L492 330 L550 300 L502 268 Z" fill="${shade}"/>
        <path d="M450 330 L450 880" ${stroke}/>
        <circle cx="462" cy="430" r="6" fill="${line}" opacity="0.5"/>
        <circle cx="462" cy="520" r="6" fill="${line}" opacity="0.5"/>
        <circle cx="462" cy="610" r="6" fill="${line}" opacity="0.5"/>
        <circle cx="462" cy="700" r="6" fill="${line}" opacity="0.5"/>
        <path d="M250 560 L318 575 M650 560 L582 575" ${stroke}/>`;
    case 'blouse':
      return `
        <path d="M450 270 Q392 282 352 306 L276 356 L256 548 L324 562 Q318 740 336 862 L564 862 Q582 740 576 562 L644 548 L624 356 L548 306 Q508 282 450 270 Z" fill="${base}"/>
        <path d="M450 270 Q424 320 450 352 Q476 320 450 270 Z" fill="${shade}"/>
        <path d="M360 620 Q450 660 540 620" ${stroke}/>
        <path d="M352 306 Q330 420 324 562" ${stroke}/>`;
    case 'tshirt':
      return `
        <path d="M450 275 L352 308 L268 362 L292 500 L352 486 L348 862 L552 862 L548 486 L608 500 L632 362 L548 308 Z" fill="${base}"/>
        <path d="M450 275 Q412 300 408 330 Q450 352 492 330 Q488 300 450 275 Z" fill="${shade}"/>
        <path d="M352 486 L348 862 M548 486 L552 862" ${stroke}/>`;
    case 'sweater':
      return `
        <path d="M450 268 L344 302 L252 366 L230 612 L300 628 L312 886 L588 886 L600 628 L670 612 L648 366 L556 302 Z" fill="${base}"/>
        <path d="M450 268 Q406 290 404 330 Q450 356 496 330 Q494 290 450 268 Z" fill="${shade}"/>
        <path d="M312 846 L588 846" ${stroke}/>
        <path d="M300 628 L230 612 M600 628 L670 612" ${stroke}/>
        <path d="M380 420 Q450 450 520 420 M380 520 Q450 550 520 520 M380 620 Q450 650 520 620 M380 720 Q450 750 520 720" ${stroke}/>`;
    case 'cardigan':
      return `
        <path d="M450 268 L344 302 L252 366 L230 612 L300 628 L312 886 L588 886 L600 628 L670 612 L648 366 L556 302 Z" fill="${base}"/>
        <path d="M450 290 L450 886" stroke="${line}" stroke-width="4" fill="none" opacity="0.6"/>
        <circle cx="470" cy="420" r="8" fill="${line}" opacity="0.5"/>
        <circle cx="470" cy="520" r="8" fill="${line}" opacity="0.5"/>
        <circle cx="470" cy="620" r="8" fill="${line}" opacity="0.5"/>
        <circle cx="470" cy="720" r="8" fill="${line}" opacity="0.5"/>
        <path d="M380 290 L380 886" ${stroke}/>`;
    case 'hoodie':
      return `
        <path d="M450 250 Q372 258 356 310 L256 372 L232 618 L302 634 L314 890 L586 890 L598 634 L668 618 L644 372 L544 310 Q528 258 450 250 Z" fill="${base}"/>
        <path d="M450 250 Q380 262 362 318 Q450 360 538 318 Q520 262 450 250 Z" fill="${shade}"/>
        <path d="M404 318 L424 420 M496 318 L476 420" ${stroke}/>
        <path d="M360 700 Q450 730 540 700" ${stroke}/>
        <path d="M314 850 L586 850" ${stroke}/>`;
    case 'vest':
      return `
        <path d="M450 268 L350 302 L300 352 L288 700 L348 712 L352 886 L548 886 L552 712 L612 700 L600 352 L550 302 Z" fill="${base}"/>
        <path d="M450 268 L404 404 L350 302" fill="${shade}"/>
        <path d="M450 268 L496 404 L550 302" fill="${shade}"/>
        <path d="M450 404 L450 886" ${stroke}/>`;
    case 'trousers':
      return `
        <path d="M322 250 L578 250 L592 320 L566 1010 L470 1010 L450 520 L430 1010 L334 1010 L308 320 Z" fill="${base}"/>
        <path d="M322 250 L578 250 L584 292 L316 292 Z" fill="${shade}"/>
        <path d="M450 292 L450 520" ${stroke}/>
        <path d="M400 340 L404 300 M500 340 L496 300" ${stroke}/>`;
    case 'jeans':
      return `
        <path d="M322 250 L578 250 L592 320 L566 1010 L470 1010 L450 520 L430 1010 L334 1010 L308 320 Z" fill="${base}"/>
        <path d="M322 250 L578 250 L584 300 L316 300 Z" fill="${shade}"/>
        <path d="M450 300 L450 520" ${stroke}/>
        <path d="M340 330 Q372 358 404 332 M560 330 Q528 358 496 332" ${stroke}/>
        <path d="M340 360 L348 420 M560 360 L552 420" ${stroke}/>
        <path d="M330 940 L432 940 M468 940 L570 940" ${stroke}/>`;
    case 'shorts':
      return `
        <path d="M322 250 L578 250 L592 318 L578 640 L482 640 L450 460 L418 640 L322 640 L308 318 Z" fill="${base}"/>
        <path d="M322 250 L578 250 L584 294 L316 294 Z" fill="${shade}"/>
        <path d="M450 294 L450 460" ${stroke}/>`;
    case 'skirt':
      return `
        <path d="M344 250 L556 250 L572 310 L648 920 L252 920 L328 310 Z" fill="${base}"/>
        <path d="M344 250 L556 250 L562 300 L338 300 Z" fill="${shade}"/>
        <path d="M400 310 L352 920 M450 310 L450 920 M500 310 L548 920" ${stroke}/>`;
    case 'dress':
      return `
        <path d="M450 262 Q396 276 362 306 L312 352 L336 520 L370 512 Q352 700 272 980 L628 980 Q548 700 530 512 L564 520 L588 352 L538 306 Q504 276 450 262 Z" fill="${base}"/>
        <path d="M450 262 Q420 306 450 338 Q480 306 450 262 Z" fill="${shade}"/>
        <path d="M370 512 Q450 544 530 512" ${stroke}/>
        <path d="M380 620 Q450 980 380 980 M520 620 Q450 980 520 980" ${stroke}/>`;
    case 'sneaker':
      return `
        <path d="M250 700 Q266 580 330 568 Q392 560 432 606 Q498 648 592 664 Q668 678 674 730 L676 790 Q676 816 648 816 L278 816 Q250 816 250 788 Z" fill="${base}"/>
        <path d="M250 788 Q250 816 278 816 L648 816 Q676 816 676 790 L676 762 L250 762 Z" fill="${shade}"/>
        <path d="M250 762 L676 762" stroke="${line}" stroke-width="3" fill="none" opacity="0.6"/>
        <path d="M344 586 L372 646 M384 578 L412 638 M424 596 L452 656" ${stroke}/>
        <path d="M560 668 Q590 700 596 762" ${stroke}/>`;
    case 'loafer':
      return `
        <path d="M252 712 Q268 626 344 614 Q440 604 530 640 Q620 672 668 700 Q690 714 690 756 Q690 800 650 800 L292 800 Q252 800 252 764 Z" fill="${base}"/>
        <path d="M252 764 Q252 800 292 800 L650 800 Q690 800 690 760 L252 760 Z" fill="${shade}"/>
        <path d="M330 640 Q420 676 470 700" ${stroke}/>
        <path d="M398 652 L452 652" stroke="${line}" stroke-width="7" fill="none" opacity="0.6"/>`;
    case 'boot':
      return `
        <path d="M320 380 L520 380 L534 700 Q608 716 660 744 Q688 760 688 792 Q688 828 650 828 L330 828 Q300 828 300 796 L306 420 Z" fill="${base}"/>
        <path d="M300 796 Q300 828 330 828 L650 828 Q688 828 688 792 L688 780 L300 780 Z" fill="${shade}"/>
        <path d="M320 380 L520 380 L524 430 L316 430 Z" fill="${shade}"/>
        <path d="M330 500 L512 500 M330 580 L520 580" ${stroke}/>`;
    case 'heel':
      return `
        <path d="M268 700 Q288 618 362 606 Q462 598 556 650 Q640 696 672 740 Q690 764 672 784 L324 784 Q268 784 268 744 Z" fill="${base}"/>
        <path d="M640 784 L656 784 L672 980 L628 980 Z" fill="${base}"/>
        <path d="M268 744 Q268 784 324 784 L672 784 L672 770 L268 770 Z" fill="${shade}"/>
        <path d="M360 626 Q460 656 540 700" ${stroke}/>`;
    case 'bag':
      return `
        <path d="M300 480 L600 480 L628 880 L272 880 Z" fill="${base}"/>
        <path d="M300 480 L600 480 L606 560 L294 560 Z" fill="${shade}"/>
        <path d="M368 480 Q368 320 450 320 Q532 320 532 480" ${stroke} stroke-width="12" opacity="0.7"/>
        <rect x="414" y="548" width="72" height="44" rx="8" fill="${line}" opacity="0.45"/>`;
    case 'belt':
      return `
        <path d="M230 580 L640 580 L640 660 L230 660 Z" fill="${base}"/>
        <path d="M230 580 L640 580 L640 604 L230 604 Z" fill="${shade}"/>
        <rect x="636" y="556" width="96" height="128" rx="18" fill="none" stroke="${line}" stroke-width="14" opacity="0.6"/>
        <path d="M684 556 L684 684" stroke="${line}" stroke-width="8" opacity="0.6"/>
        <path d="M280 620 L300 620 M340 620 L360 620 M400 620 L420 620" ${stroke}/>`;
    case 'scarf':
      return `
        <path d="M300 320 Q450 400 600 320 L636 420 Q450 520 264 420 Z" fill="${base}"/>
        <path d="M264 420 Q310 640 288 860 L404 860 Q420 640 386 452 Z" fill="${base}"/>
        <path d="M514 452 Q480 640 496 860 L612 860 Q590 640 636 420 Z" fill="${shade}"/>
        <path d="M288 820 L404 820 M496 820 L612 820" ${stroke}/>`;
    case 'cap':
      return `
        <path d="M280 640 Q280 440 450 440 Q620 440 620 640 Z" fill="${base}"/>
        <path d="M620 640 Q760 650 776 700 L616 700 Z" fill="${shade}"/>
        <path d="M450 440 L450 640 M360 470 Q400 560 400 640 M540 470 Q500 560 500 640" ${stroke}/>`;
    default:
      return `<rect x="300" y="380" width="300" height="420" rx="24" fill="${base}"/>`;
  }
}

export interface ProductImageSpec {
  readonly fileName: string;
  readonly shape: GarmentShape;
  readonly colorFamily: string;
  readonly brandName: string;
  readonly label: string;
  readonly variant?: 'main' | 'detail' | 'back';
}

export function renderProductSvg(spec: ProductImageSpec): string {
  const colors = palette(spec.colorFamily);
  const variant = spec.variant ?? 'main';
  const id = spec.fileName.replace(/[^a-z0-9]/gi, '');

  // The detail view crops in; the back view mirrors. One drawing, three
  // legitimate angles, which is what the media standard asks for.
  const transform =
    variant === 'detail'
      ? 'translate(-340 -430) scale(1.75)'
      : variant === 'back'
        ? 'translate(900 0) scale(-1 1)'
        : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(spec.label)}">
  <defs>
    <linearGradient id="bg${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${colors.backdrop}"/>
      <stop offset="62%" stop-color="#faf9f7"/>
      <stop offset="100%" stop-color="${colors.backdrop}"/>
    </linearGradient>
    <radialGradient id="vig${id}" cx="50%" cy="42%" r="72%">
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#2b2a28" stop-opacity="0.1"/>
    </radialGradient>
    <radialGradient id="shadow${id}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#2b2a28" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#2b2a28" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain${id}" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${hash(spec.fileName)}"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer>
    </filter>
    <clipPath id="frame${id}"><rect width="${WIDTH}" height="${HEIGHT}"/></clipPath>
  </defs>

  <g clip-path="url(#frame${id})">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg${id})"/>
    <ellipse cx="450" cy="1030" rx="300" ry="54" fill="url(#shadow${id})"/>
    <g transform="${transform}">${garment(spec.shape, colors)}</g>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#vig${id})"/>
    <rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain${id})" opacity="0.5"/>

    <text x="56" y="1148" font-family="Georgia, 'Times New Roman', serif" font-size="30" letter-spacing="5" fill="#2b2a28" opacity="0.62">${escapeXml(spec.brandName.toUpperCase())}</text>
    <text x="${WIDTH - 56}" y="76" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="19" letter-spacing="3.4" fill="#2b2a28" opacity="0.4">${escapeXml(variant.toUpperCase())}</text>
  </g>
</svg>`;
}

/** Brand wordmark for the brand rail and the PDP header. */
export function renderBrandLogoSvg(name: string, colorFamily = 'black'): string {
  const colors = palette(colorFamily);
  const initials = name
    .split(/[\s&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
  const id = name.replace(/[^a-z0-9]/gi, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" role="img" aria-label="${escapeXml(name)}">
  <defs><linearGradient id="lg${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${colors.base}"/><stop offset="100%" stop-color="${colors.shade}"/>
  </linearGradient></defs>
  <rect width="240" height="240" rx="56" fill="url(#lg${id})"/>
  <text x="120" y="120" text-anchor="middle" dominant-baseline="central" font-family="Georgia, serif" font-size="86" letter-spacing="3" fill="#faf9f7">${escapeXml(initials)}</text>
</svg>`;
}

/** Wide editorial banner for a CMS hero or a collection cover. */
export function renderBannerSvg(input: {
  title: string;
  subtitle?: string;
  colorFamily: string;
  shapes: GarmentShape[];
}): string {
  const colors = palette(input.colorFamily);
  const id = input.title.replace(/[^a-z0-9]/gi, '').slice(0, 20);
  const width = 1440;
  const height = 900;

  const figures = input.shapes
    .slice(0, 3)
    .map((shape, index) => {
      const x = 300 + index * 380;
      return `<g transform="translate(${x - 450} 90) scale(0.72)" opacity="${0.95 - index * 0.12}">${garment(shape, colors)}</g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(input.title)}">
  <defs>
    <linearGradient id="bb${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${colors.backdrop}"/>
      <stop offset="55%" stop-color="#fbfaf8"/>
      <stop offset="100%" stop-color="${colors.backdrop}"/>
    </linearGradient>
    <linearGradient id="scrim${id}" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#1b1a19" stop-opacity="0.56"/>
      <stop offset="52%" stop-color="#1b1a19" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="bc${id}"><rect width="${width}" height="${height}"/></clipPath>
  </defs>
  <g clip-path="url(#bc${id})">
    <rect width="${width}" height="${height}" fill="url(#bb${id})"/>
    <ellipse cx="${width / 2}" cy="${height - 60}" rx="520" ry="60" fill="#2b2a28" opacity="0.12"/>
    ${figures}
    <rect width="${width}" height="${height}" fill="url(#scrim${id})"/>
    <text x="72" y="${height - 128}" font-family="Georgia, serif" font-size="74" fill="#faf9f7">${escapeXml(input.title)}</text>
    ${input.subtitle ? `<text x="76" y="${height - 72}" font-family="Helvetica, Arial, sans-serif" font-size="27" letter-spacing="1.4" fill="#faf9f7" opacity="0.88">${escapeXml(input.subtitle)}</text>` : ''}
  </g>
</svg>`;
}

/** Dominant colour, so the UI can tint the placeholder before the image loads. */
export function placeholderColor(colorFamily: string): string {
  return palette(colorFamily).backdrop;
}

export interface WrittenMedia {
  readonly fileName: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly placeholder: string;
}

export async function writeSvg(
  directory: string,
  fileName: string,
  content: string,
  publicBase: string,
  size: { width: number; height: number },
  colorFamily: string,
): Promise<WrittenMedia> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), content, 'utf8');
  return {
    fileName,
    url: `${publicBase.replace(/\/$/, '')}/${fileName}`,
    width: size.width,
    height: size.height,
    placeholder: placeholderColor(colorFamily),
  };
}

export const IMAGE_SIZE = { width: WIDTH, height: HEIGHT };
export const BANNER_SIZE = { width: 1440, height: 900 };
export const LOGO_SIZE = { width: 240, height: 240 };

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hash(value: string): number {
  let out = 0;
  for (const char of value) out = (out * 31 + char.charCodeAt(0)) % 9973;
  return out;
}
