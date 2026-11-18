/**
 * A minimal, valid TrueType font with a `.notdef` glyph and one blank glyph of a chosen advance width. Every
 * character falls back to that glyph, so the width of a terminal cell that uses it is known
 * exactly, with no font file, no network and no dependence on the fonts a host has installed.
 */

const UNITS_PER_EM = 1000;
/** `.notdef` plus one glyph for each printable ASCII character, which `cmap` maps in order. */
const GLYPHS = 96;

function table(size: number, fill: (view: DataView) => void): Uint8Array {
  const padded = Math.ceil(size / 4) * 4;
  const bytes = new Uint8Array(padded);
  fill(new DataView(bytes.buffer));
  return bytes;
}

function checksum(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 4)
    sum = (sum + view.getUint32(offset)) >>> 0;
  return sum;
}

export function probeFont(advance: number): Uint8Array {
  const tables: Array<[string, Uint8Array]> = [
    [
      'OS/2',
      table(78, (view) => {
        view.setUint16(0, 0); // version
        view.setInt16(2, advance); // xAvgCharWidth
        view.setUint16(4, 400); // usWeightClass
        view.setUint16(6, 5); // usWidthClass
        view.setUint16(64, 0x20); // usFirstCharIndex
        view.setUint16(66, 0x7e); // usLastCharIndex
        view.setInt16(68, 800); // sTypoAscender
        view.setInt16(70, -200); // sTypoDescender
        view.setUint16(74, 800); // usWinAscent
        view.setUint16(76, 200); // usWinDescent
      }),
    ],
    [
      'cmap',
      table(44, (view) => {
        view.setUint16(0, 0); // version
        view.setUint16(2, 1); // one encoding record
        view.setUint16(4, 3); // Windows
        view.setUint16(6, 1); // Unicode BMP
        view.setUint32(8, 12); // offset to the subtable
        view.setUint16(12, 4); // format 4
        view.setUint16(14, 32); // length
        view.setUint16(16, 0); // language
        view.setUint16(18, 4); // segCountX2
        view.setUint16(20, 4); // searchRange
        view.setUint16(22, 1); // entrySelector
        view.setUint16(24, 0); // rangeShift
        view.setUint16(26, 0x7e); // endCode: printable ASCII
        view.setUint16(28, 0xffff);
        view.setUint16(30, 0); // reservedPad
        view.setUint16(32, 0x20); // startCode
        view.setUint16(34, 0xffff);
        view.setInt16(36, 1 - 0x20); // idDelta: printable ASCII maps to glyph 1
        view.setInt16(38, 1);
        view.setUint16(40, 0); // idRangeOffset
        view.setUint16(42, 0);
      }),
    ],
    [
      'glyf',
      // One empty glyph: no contours, and a bounding box that matches the head table.
      table(10, (view) => {
        view.setInt16(0, 0);
        view.setInt16(4, -200);
        view.setInt16(6, advance);
        view.setInt16(8, 800);
      }),
    ],
    [
      'head',
      table(54, (view) => {
        view.setUint32(0, 0x00010000); // version
        view.setUint32(12, 0x5f0f3cf5); // magic number
        view.setUint16(16, 0); // flags
        view.setUint16(18, UNITS_PER_EM);
        view.setInt16(36, 0); // xMin
        view.setInt16(38, -200); // yMin
        view.setInt16(40, advance); // xMax
        view.setInt16(42, 800); // yMax
        view.setUint16(44, 0); // macStyle
        view.setUint16(46, 8); // lowestRecPPEM
        view.setInt16(48, 2); // fontDirectionHint
        view.setInt16(50, 0); // short loca
        view.setInt16(52, 0); // glyph data format
      }),
    ],
    [
      'hhea',
      table(36, (view) => {
        view.setUint32(0, 0x00010000);
        view.setInt16(4, 800); // ascender
        view.setInt16(6, -200); // descender
        view.setUint16(10, advance); // advanceWidthMax
        view.setUint16(34, 1); // numberOfHMetrics
      }),
    ],
    [
      'hmtx',
      // One long metric, then a left side bearing for each of the remaining glyphs.
      table(4 + 2 * (GLYPHS - 1), (view) => {
        view.setUint16(0, advance);
      }),
    ],
    [
      'loca',
      table(2 * (GLYPHS + 1), (view) => {
        // Glyph 0 is 10 bytes, stored as half-words; every other glyph has no outline.
        for (let glyph = 1; glyph <= GLYPHS; glyph += 1) view.setUint16(2 * glyph, 5);
      }),
    ],
    [
      'maxp',
      table(32, (view) => {
        view.setUint32(0, 0x00010000);
        view.setUint16(4, GLYPHS); // numGlyphs
        view.setUint16(14, 1); // maxZones
      }),
    ],
    [
      'name',
      table(18, (view) => {
        view.setUint16(0, 0); // format
        view.setUint16(2, 1); // count
        view.setUint16(4, 18); // string offset
        view.setUint16(6, 3); // Windows
        view.setUint16(8, 1); // Unicode BMP
        view.setUint16(10, 0x0409); // en-US
        view.setUint16(12, 1); // family name
        view.setUint16(14, 0); // length
        view.setUint16(16, 0); // offset
      }),
    ],
    [
      'post',
      table(32, (view) => {
        view.setUint32(0, 0x00030000); // version 3: no glyph names
      }),
    ],
  ];

  const headerSize = 12 + tables.length * 16;
  const total = headerSize + tables.reduce((sum, [, data]) => sum + data.byteLength, 0);
  const font = new Uint8Array(total);
  const view = new DataView(font.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  const power = 2 ** Math.floor(Math.log2(tables.length));
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, tables.length * 16 - power * 16);
  let offset = headerSize;
  tables.forEach(([tag, data], index) => {
    const record = 12 + index * 16;
    for (let character = 0; character < 4; character += 1) {
      font[record + character] = tag.charCodeAt(character);
    }
    view.setUint32(record + 4, checksum(data));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, data.byteLength);
    font.set(data, offset);
    offset += data.byteLength;
  });
  return font;
}
