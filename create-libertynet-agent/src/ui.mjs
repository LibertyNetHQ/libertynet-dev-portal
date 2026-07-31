/**
 * Terminal presentation.
 *
 * Living Language in a terminal: pure black ground is whatever the user already
 * has, life cyan is the only colour we add, and nothing moves. No spinner — the
 * whole run takes under a second, and a spinner for sub-second work is theatre.
 *
 * Colour is always paired with a word. A reader on a monochrome terminal, or a
 * screen-reader user, loses nothing.
 */

const supportsColor =
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const wrap = (open, close) => (s) => (supportsColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);

/** Life cyan #00E5C7, as close as 256-colour gets. */
export const cyan = wrap("38;5;43", "39");
export const dim = wrap("2", "22");
export const bold = wrap("1", "22");
export const red = wrap("38;5;210", "39");
export const amber = wrap("38;5;215", "39");

export const mark = () => cyan("◐");

export function banner() {
  return `\n${mark()} ${bold("LibertyNet")}  ${dim("create-libertynet-agent")}\n`;
}

export function ok(msg) {
  return `${cyan("✓")} ${msg}`;
}

export function warn(msg) {
  return `${amber("!")} ${msg}`;
}

export function fail(msg) {
  return `${red("✗")} ${msg}`;
}

export function step(msg) {
  return `  ${dim("·")} ${msg}`;
}
