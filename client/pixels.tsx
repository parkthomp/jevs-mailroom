import { LOOKS, type Category, type Facing } from '../shared/protocol';

// The classic four-shade handheld palette, darkest to lightest. CSS mirrors these as --p0..--p3.
export const PALETTE = ['#081820', '#346856', '#88c070', '#e0f8d0'] as const;

// Sprites are rows of palette indices; '.' is transparent. In the DOM, shade 0 follows currentColor.
export type SpriteData = readonly string[];

export const JEV_STAND: SpriteData = [
  '....0000....',
  '..00111100..',
  '.0111111110.',
  '.0000000000.',
  '.0333333330.',
  '.0303333030.',
  '.0333333330.',
  '.0233003320.',
  '..00333300..',
  '..01133110..',
  '.0111111110.',
  '011111111110',
  '031111111130',
  '..02222220..',
  '..02200220..',
  '..000..000..',
];
export const JEV_STEP: SpriteData = [...JEV_STAND.slice(0, 14), '...022220...', '...000000...'];
export const JEV_FACE: SpriteData = JEV_STAND.slice(0, 9);

// Visitors are a head shorter than Jev. Each wears one of LOOKS outfits: a hairstyle, a hair shade, and
// a shirt shade. H, S, and P stand for hair, shirt, and trousers until the look fills them in.
const EYES: Record<Facing, string> = { down: '303303', left: '303333', right: '333303', up: 'HHHHHH' };
function visitorRows(style: number, facing: Facing, step: boolean): string[] {
  const back = facing === 'up', eyes = EYES[facing];
  const top = ['...0000...', '..0HHHH0..', '.0HHHHHH0.', style === 2 ? '.00000000.' : back ? '.0HHHHHH0.' : '.0H3333H0.'];
  const face = style === 1
    ? [`0H${eyes}H0`, back ? '0HHHHHHHH0' : '0H333333H0', back ? '0H0HHHH0H0' : '0H033330H0']
    : [`.0${eyes}0.`, back ? '.0HHHHHH0.' : '.03333330.', back ? '..0HHHH0..' : '..033330..'];
  const legs = step ? ['..0PPPP0..', '...0PP0...', '...0000...'] : ['..0PPPP0..', '..0P00P0..', '..00..00..'];
  return [...top, ...face, '..0SSSS0..', '.0SSSSSS0.', '03SSSSSS30', '.0SSSSSS0.', ...legs];
}
const visitorSprites = new Map<string, SpriteData>();
export function visitorSprite(look: number, facing: Facing, step: boolean): SpriteData {
  const key = `${look}:${facing}:${step}`;
  let sprite = visitorSprites.get(key);
  if (!sprite) {
    const index = ((look % LOOKS) + LOOKS) % LOOKS, style = index % 3, hair = String(Math.floor(index / 3) % 3), shirt = index < 9 ? '2' : '1';
    sprite = visitorRows(style, facing, step).map(row => row.replaceAll('H', hair).replaceAll('S', shirt).replaceAll('P', shirt === '2' ? '1' : '0'));
    visitorSprites.set(key, sprite);
  }
  return sprite;
}
// Bobs over your own character, and over Jev when you're close enough to talk.
export const MARKER: SpriteData = ['00000', '.000.', '..0..'];

export const ENVELOPE: SpriteData = ['00000000', '00333300', '03033030', '03300330', '03333330', '00000000'];
// The sender's own envelope is shaded so they can pick it out on the trolley.
export const ENVELOPE_OWN: SpriteData = ENVELOPE.map(row => row.replaceAll('3', '2'));

export const BIN_ICONS: Record<Category, SpriteData> = {
  compliments: ['.00.00.', '0000000', '0000000', '0000000', '.00000.', '..000..', '...0...'],
  ideas: ['..000..', '.03000.', '.00000.', '.00000.', '..000..', '.......', '..000..'],
  complaints: ['.00000.', '0000000', '0030300', '0000000', '0033300', '0300030', '.00000.'],
  misc: ['.00000.', '00...00', '....00.', '...00..', '...00..', '.......', '...00..'],
};

export const ARROW: SpriteData = ['0...', '00..', '000.', '0000', '000.', '00..', '0...'];
export const DOWN: SpriteData = ['0000000', '.00000.', '..000..', '...0...'];
export const UP: SpriteData = [...DOWN].reverse();
export const CHECK: SpriteData = ['......0', '.....00', '0...00.', '00.00..', '.000...', '..0....'];
export const CLOSE: SpriteData = ['00...00', '000.000', '.00000.', '..000..', '.00000.', '000.000', '00...00'];
export const PERSON: SpriteData = ['..000..', '.00000.', '.00000.', '..000..', '.......', '.00000.', '0000000', '0000000'];
export const EXCLAIM: SpriteData = ['.00000.', '000.000', '000.000', '000.000', '0000000', '000.000', '.00000.'];
export const TRASH_ICON: SpriteData = ['..000..', '0000000', '.......', '.00000.', '.0.0.0.', '.0.0.0.', '.0.0.0.', '.00000.'];
export const PLANT: SpriteData = [
  '..00...00.',
  '.0110.0110',
  '.01110110.',
  '..011110..',
  '...0110...',
  '....00....',
  '.00000000.',
  '.02222220.',
  '..022220..',
  '..022220..',
  '..000000..',
];

// A 3×5 bitmap font for labels painted inside the room, read row by row.
export const FONT: Record<string, string> = {
  A: '111101111101101', B: '111101110101111', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101111', H: '101101111101101', I: '111010010010111', J: '111010010010110',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '101111111111101', O: '010101101101010',
  P: '111101111100100', Q: '010101101110011', R: '111101110101101', S: '011100111001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101101111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '110010010010111', 2: '111001111100111', 3: '111001011001111',
  4: '101101111001001', 5: '111100111001111', 6: '100100111101111', 7: '111001001001001', 8: '111101111101111',
  9: '111101111001001', "'": '010010000000000', '.': '000000000000010', ' ': '000000000000000', '?': '111001011000010',
  '!': '010010010000010', '-': '000000111000000', ':': '000010000010000',
};

const paths = new WeakMap<SpriteData, [string, string][]>();
function toPaths(data: SpriteData) {
  let cached = paths.get(data);
  if (!cached) {
    const byShade: Record<string, string> = {};
    data.forEach((row, y) => {
      for (let x = 0; x < row.length;) {
        const shade = row[x];
        let end = x + 1;
        while (row[end] === shade) end++;
        if (shade !== '.') byShade[shade] = (byShade[shade] || '') + `M${x} ${y}h${end - x}v1h-${end - x}z`;
        x = end;
      }
    });
    cached = Object.entries(byShade);
    paths.set(data, cached);
  }
  return cached;
}

export function Sprite({ data, size = 3, className }: { data: SpriteData; size?: number; className?: string }) {
  const width = data[0].length, height = data.length;
  return <svg className={className} width={width * size} height={height * size} viewBox={`0 0 ${width} ${height}`} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    {toPaths(data).map(([shade, d]) => <path key={shade} d={d} fill={shade === '0' ? 'currentColor' : `var(--p${shade})`} />)}
  </svg>;
}
