// SPEC §5.2 palette (index -> RGB).
export const PALETTE_HEX = [
  '0b0d12', 'ffffff', 'c9ced6', '5c6370', 'e63946', 'f4a261', 'ffd166', '8ac926',
  '2a9d8f', '4cc9f0', '3a86ff', '7b2cbf', 'ff70a6', 'a0522d', 'f1dcc1', 'ffbf69',
];
export const PALETTE_RGB: [number, number, number][] = PALETTE_HEX.map((h) => [
  parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
]);
export const W = 32;
