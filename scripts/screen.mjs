/**
 * Reconstruct the visible terminal screen from a PTY recording.
 *
 * `script` records raw output, and the TUI paints with absolute cursor
 * positioning: it writes "Foundation" at column 161 and "0/2" at column 172 as
 * two separate writes. Splitting the log on cursor moves therefore fragments a
 * single visual row into several strings, and any assertion written against
 * those fragments is measuring the escape stream, not the screen.
 *
 * This replays the sequences the TUI actually emits into a grid, so the sidebar
 * can be read the way a person sees it. Every sequence seen across a full
 * session is handled: absolute cursor position, SGR (ignored, it only sets
 * color), and OSC (ignored, it sets the window title). Any other sequence is
 * skipped, which cannot corrupt the grid because the TUI does not emit one.
 */

const CURSOR_POSITION = /^\x1b\[(\d+);(\d+)[Hf]/;
const SGR = /^\x1b\[[0-9;?]*m/;
const OSC = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/;
const OTHER_CSI = /^\x1b\[[0-9;?]*[a-zA-Z]/;

export function renderScreen(raw, { rows = 60, cols = 220 } = {}) {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
  let row = 0;
  let col = 0;
  let index = 0;

  const clamp = () => {
    if (row < 0) row = 0;
    if (col < 0) col = 0;
    if (row >= rows) row = rows - 1;
    if (col >= cols) col = cols - 1;
  };

  while (index < raw.length) {
    if (raw[index] === "\x1b") {
      const rest = raw.slice(index);
      const match =
        CURSOR_POSITION.exec(rest) ?? SGR.exec(rest) ?? OSC.exec(rest) ?? OTHER_CSI.exec(rest);
      if (match) {
        const position = CURSOR_POSITION.exec(rest);
        if (position) {
          row = Number(position[1]) - 1;
          col = Number(position[2]) - 1;
          clamp();
        }
        index += match[0].length;
        continue;
      }
      index += 1;
      continue;
    }

    const char = raw[index];
    if (char === "\r") {
      col = 0;
    } else if (char === "\n") {
      row += 1;
      clamp();
    } else if (char !== "\x07" && char !== "\x00") {
      // The host advances by DISPLAY COLUMNS, not code units: it moves from
      // column 72 to 74 to write the second CJK glyph. Advancing one cell per
      // code unit leaves an unwritten gap after every wide glyph, so a
      // reconstructed row reads "実 装" and never matches the real text. The
      // trailing cell a wide glyph covers is marked so the join drops it.
      const width = clusterColumns(raw, index);
      if (col < cols && row < rows) {
        grid[row][col] = char;
        for (let extra = 1; extra < width && col + extra < cols; extra++) {
          grid[row][col + extra] = WIDE_CONTINUATION;
        }
      }
      col += width;
      clamp();
    }
    index += 1;
  }

  return grid.map((line) => line.join("").split(WIDE_CONTINUATION).join("").replace(/\s+$/, ""));
}

/** Marks the cell a wide glyph covers beyond its first column. */
const WIDE_CONTINUATION = "\u0000";

/** Columns the character at `index` occupies: 2 for a wide glyph, else 1. */
function clusterColumns(raw, index) {
  const code = raw.codePointAt(index);
  if (code === undefined) return 1;
  return isWide(code) ? 2 : 1;
}

/** East Asian Wide and Fullwidth forms, and emoji. Mirrors `hud.ts`. */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x1f000 && code <= 0x1f2ff)
  );
}

/** Non-empty screen lines, in screen order. */
export function screenLines(raw, options) {
  return renderScreen(raw, options).filter((line) => line.trim() !== "");
}
