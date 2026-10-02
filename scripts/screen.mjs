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
      if (col < cols && row < rows) grid[row][col] = char;
      col += 1;
      clamp();
    }
    index += 1;
  }

  return grid.map((line) => line.join("").replace(/\s+$/, ""));
}

/** Non-empty screen lines, in screen order. */
export function screenLines(raw, options) {
  return renderScreen(raw, options).filter((line) => line.trim() !== "");
}
