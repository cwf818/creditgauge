// Compose our token-plan line with an arbitrary upstream statusline output.
// Upstream is passed by the bash wrapper via the CREDITGAUGE_UPSTREAM env var.
//
// Rules:
//   - Preserve interior newlines in upstream (multi-line statuslines are valid).
//   - Strip only trailing whitespace from upstream.
//   - Ensure exactly one newline separator between upstream and our plan line.
//   - If upstream contains an ANSI SGR sequence (\x1b[) whose last escape does
//     not terminate with \x1b[0m (or the equivalent \x1b[m), inject \x1b[0m so
//     our plan line is not colored by upstream's last open style.
//   - The plan line itself may contain newlines (v0.4.0+ — when a
//     lineTemplate separator is "\n", the renderer emits multi-line output).
//     Each plan line is treated independently: any unclosed SGR is closed
//     before the line ends, so the next line starts clean. Blank lines
//     from trailing "\n" or consecutive "\n\n" are dropped.

const RESET = "\x1b[0m";

function hasUnclosedSgr(text: string): boolean {
  // Scan for any CSI introducer; if the LAST one is not a reset (or is followed
  // by another CSI after it), the text ends with an unclosed style. We treat
  // anything that matches \x1b[ as a potential SGR — even non-SGR CSI is
  // safe to reset (it just clears attributes).
  const lastIdx = text.lastIndexOf("\x1b[");
  if (lastIdx === -1) return false;
  const tail = text.slice(lastIdx);
  // If the tail is "\x1b[0m" or "\x1b[m" (a reset), it's closed.
  if (/^\x1b\[(0m?|m)$/.test(tail)) return false;
  // Otherwise it's an open style (or any non-reset CSI) that bleeds into
  // anything we append.
  return true;
}

// Close any unclosed SGR at the end of `line`. Returns `line` unchanged when
// the line is already closed. Used to make each rendered plan line
// self-contained — an unclosed color on line 1 would otherwise bleed
// into line 2's prompt.
function closeLine(line: string): string {
  return hasUnclosedSgr(line) ? `${line}${RESET}` : line;
}

// Split `planLine` on '\n' and drop empty segments. Each non-empty segment
// gets its SGR closed independently. Returns [] when planLine has no
// renderable content.
function planLines(planLine: string): string[] {
  return planLine
    .split("\n")
    .map((s) => closeLine(s))
    .filter((s) => s.length > 0);
}

export function compose(
  upstream: string | undefined,
  planLine: string | string[] | null,
): string {
  const upstreamText = upstream ?? "";
  if (planLine == null) {
    return upstreamText;
  }
  // Accept either a string (single-line, the common case) or a string[]
  // (multi-line, when callers built the lines themselves). Normalize to
  // an array; close any unclosed SGR on each line.
  const lines = Array.isArray(planLine)
    ? planLine.map(closeLine).filter((s) => s.length > 0)
    : planLines(planLine);
  if (lines.length === 0) {
    return upstreamText;
  }
  if (upstreamText === "") {
    return `${lines.join("\n")}\n`;
  }

  // Strip ONLY trailing whitespace (spaces, tabs, newlines) so multi-line
  // upstream keeps its interior structure intact.
  const trimmedUp = upstreamText.replace(/[\s]+$/, "");

  // Decide whether to insert a reset between upstream and the FIRST plan
  // line. Each plan line is independently closed (closeLine above), so
  // we only need to address the gap between upstream's tail and our
  // first plan line.
  const reset = hasUnclosedSgr(trimmedUp) ? RESET : "";

  return `${trimmedUp}\n${reset}${lines.join("\n")}\n`;
}