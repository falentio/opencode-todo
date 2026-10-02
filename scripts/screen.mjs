/**
 * Reconstruct the visible terminal screen from a PTY recording.
 *
 * `script` records raw output, and the TUI paints with absolute cursor
 * positioning: it writes "Foundation" at column 161 and "0/2" at column 172 as
 * two separate writes. Splitting the log on cursor moves therefore fragments a
 * single visual row into several strings, and any assertion written against
 * those fragments is measuring the escape stream, not the screen.
 *
 * This replays the escape sequences into a grid so the sidebar can be read the
 * way a person sees it. Only the sequences the TUI actually emits are handled:
 * absolute cursor position, erase-in-line, erase-in-display, and SGR (ignored).
 */

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
    const rest = raw.slice(index);

    if (rest.startsWith("\x1b")) {
      const position = /^\x1b\[(\d+);(\d+)[Hf]/.exec(rest);
      if (position) {
        row = Number(position[1]) - 1;
        col = Number(position[2]) - 1;
        clamp();
        index += position[0].length;
        continue;
      }
      const forward = /^\x1b\[(\d*)C/.exec(rest);
      if (forward) {
        col += Number(forward[1] || 1);
        clamp();
        index += forward[0].length;
        continue;
      }
      const eraseLine = /^\x1b\[(\d*)K/.exec(rest);
      if (eraseLine) {
        // 0 (and the default) erase to end of line, 2 the whole line.
        const mode = eraseLine[1];
        const from = mode === "2" ? 0 : col;
        for (let c = from; c < cols; c++) grid[row][c] = " ";
        index += eraseLine[0].length;
        continue;
      }
      const eraseDisplay = /^\x1b\[(\d*)J/.exec(rest);
      if (eraseDisplay) {
        const mode = eraseDisplay[1];
        if (mode === "2" || mode === "3") {
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid[r][c] = " ";
        }
        index += eraseDisplay[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);
      if (osc) {
        index += osc[0].length;
        continue;
      }
      const other = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(rest);
      if (other) {
        index += other[0].length;
        continue;
      }
      const charset = /^\x1b[()][A-Z0-9]/.exec(rest);
      if (charset) {
        index += charset[0].length;
        continue;
      }
      index += 1;
      continue;
    }

    const char = raw[index];
    if (char === "\r") {
      col = 0;
      index += 1;
      continue;
    }
    if (char === "\n") {
      row += 1;
      clamp();
      index += 1;
      continue;
    }
    if (char === "\x07" || char === "\x00") {
      index += 1;
      continue;
    }
    if (col < cols && row < rows) grid[row][col] = char;
    col += 1;
    clamp();
    index += 1;
  }

  return grid.map((line) => line.join("").replace(/\s+$/, ""));
}

/** Non-empty screen lines, in screen order. */
export function screenLines(raw, options) {
  return renderScreen(raw, options).filter((line) => line.trim() !== "");
}
