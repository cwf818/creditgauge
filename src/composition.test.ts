import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compose } from "./composition.ts";

describe("compose", () => {
  it("emits only the plan line when no upstream", () => {
    assert.equal(compose(undefined, "5h ▓ 50% · 7d ▓ 50%"), "5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("emits only upstream when plan line is null", () => {
    assert.equal(compose("hud line", null), "hud line");
  });

  it("emits upstream on first line, plan line on second", () => {
    const out = compose("hud line", "5h ▓ 50% · 7d ▓ 50%");
    assert.equal(out, "hud line\n5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("strips trailing newlines from upstream to avoid blank lines", () => {
    const out = compose("hud line\n\n", "5h ▓ 50% · 7d ▓ 50%");
    assert.equal(out, "hud line\n5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("preserves interior newlines in multi-line upstream", () => {
    const upstream = "line 1\nline 2\nline 3";
    const out = compose(upstream, "5h ▓ 50% · 7d ▓ 50%");
    assert.equal(out, "line 1\nline 2\nline 3\n5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("adds a missing trailing newline to upstream", () => {
    // No trailing \n on upstream — our line must not glue onto the last char.
    const out = compose("hud line", "5h ▓ 50% · 7d ▓ 50%");
    assert.equal(out, "hud line\n5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("emits empty upstream as just the plan line", () => {
    const out = compose("", "5h ▓ 50% · 7d ▓ 50%");
    assert.equal(out, "5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("injects ANSI reset when upstream ends with an unclosed SGR", () => {
    // Upstream paints its last segment red but never resets.
    const upstream = "ctx \x1b[31m[bold red]\x1b[0m \x1b[31m";
    const out = compose(upstream, "5h ▓ 50% · 7d ▓ 50%");
    // The \x1b[0m is inserted between upstream's last char and our plan line.
    assert.equal(out, "ctx \x1b[31m[bold red]\x1b[0m \x1b[31m\n\x1b[0m5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("does not inject reset when upstream already ends with one", () => {
    const upstream = "ctx \x1b[31m[red]\x1b[0m";
    const out = compose(upstream, "5h ▓ 50% · 7d ▓ 50%");
    assert.equal(out, "ctx \x1b[31m[red]\x1b[0m\n5h ▓ 50% · 7d ▓ 50%\n");
  });

  it("does not inject reset when upstream has no ANSI at all", () => {
    const upstream = "plain line\nanother line";
    const out = compose(upstream, "5h ▓ 50% · 7d ▓ 50%");
    assert.equal(out, "plain line\nanother line\n5h ▓ 50% · 7d ▓ 50%\n");
  });
});

describe("compose — multi-line planLine (v0.4.0+)", () => {
  // When a lineTemplate separator is "\n", the rendered planLine
  // arrives as a multi-line string. compose() must treat each line
  // independently: preserve newlines verbatim, close any unclosed
  // SGR per line so colors don't bleed into the next prompt, and
  // drop empty trailing/leading lines.

  it("emits each plan line on its own stdout line", () => {
    const plan = "line1\nline2\nline3";
    const out = compose("upstream", plan);
    assert.equal(out, "upstream\nline1\nline2\nline3\n");
  });

  it("no upstream: each plan line still emitted on its own line", () => {
    const plan = "line1\nline2";
    assert.equal(compose(undefined, plan), "line1\nline2\n");
  });

  it("closes unclosed SGR on each plan line", () => {
    // m_tokenInSpeed wraps its output in STALE_COLOR (gray) but never
    // closes it; if compose() just passed it through, the next
    // prompt would inherit the gray. Verify the reset is appended.
    const STALE = "\x1b[90m";
    const plan = `${STALE}in:272.5/s\n${STALE}out:0.3/s`;
    const out = compose("upstream", plan);
    // Each line gets a trailing \x1b[0m so the next line / prompt
    // starts unstyled.
    assert.equal(
      out,
      `upstream\n${STALE}in:272.5/s\x1b[0m\n${STALE}out:0.3/s\x1b[0m\n`,
    );
  });

  it("does not double-close lines that already end with RESET", () => {
    const STALE = "\x1b[90m";
    const RESET = "\x1b[0m";
    const plan = `${STALE}in:272.5/s${RESET}\nout:0.3/s`;
    const out = compose("upstream", plan);
    // First line already closes itself; second line has no open SGR
    // so nothing is appended.
    assert.equal(out, `upstream\n${STALE}in:272.5/s${RESET}\nout:0.3/s\n`);
  });

  it("drops blank lines from consecutive '\\n' separators", () => {
    // A trailing "\n" or a "\n\n" in the middle produces an empty
    // segment that compose() filters out — no spurious blank lines
    // in the rendered statusline.
    const plan = "line1\n\nline2";
    const out = compose("upstream", plan);
    assert.equal(out, "upstream\nline1\nline2\n");
  });

  it("accepts string[] directly for callers that built lines themselves", () => {
    const out = compose("upstream", ["line1", "line2"]);
    assert.equal(out, "upstream\nline1\nline2\n");
  });

  it("string[] with unclosed SGR on each entry — closes each independently", () => {
    const STALE = "\x1b[90m";
    const out = compose(undefined, [`${STALE}line1`, `${STALE}line2`]);
    assert.equal(out, `${STALE}line1\x1b[0m\n${STALE}line2\x1b[0m\n`);
  });

  it("upstream with unclosed SGR + multi-line plan: each plan line closed", () => {
    // upstream ends with red and never resets. compose() inserts a
    // reset before the first plan line AND ensures every plan line
    // is independently closed (so a future module that opens red
    // would still be safe).
    const RED = "\x1b[31m";
    const STALE = "\x1b[90m";
    const upstream = `hud ${RED}`;
    const plan = `${STALE}in:272.5/s\n${STALE}out:0.3/s`;
    const out = compose(upstream, plan);
    assert.equal(
      out,
      `hud ${RED}\n\x1b[0m${STALE}in:272.5/s\x1b[0m\n${STALE}out:0.3/s\x1b[0m\n`,
    );
  });

  it("empty planLine array → returns upstream verbatim", () => {
    assert.equal(compose("hud line", []), "hud line");
  });

  it("empty planLine string → returns upstream verbatim (no spurious blank line)", () => {
    assert.equal(compose("hud line", ""), "hud line");
  });
});