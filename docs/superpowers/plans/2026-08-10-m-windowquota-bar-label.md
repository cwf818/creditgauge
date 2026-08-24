# m_windowQuota 实验性 label 参数 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental `|label:<s>` inline param to `m_windowQuota` that centers the label (≤4 code points) over the bar, coloring each label char by the positional used/remaining rule.

**Architecture:** A new internal bar builder `splitBarLabeled(usedPct, mode, width, label, coloredColor)` replaces the cell/color computation currently inside `formatOneChunk`/`formatOneChunkColored`. It builds the bar as per-display-column cells, colors each cell positionally (independent of glyph content), then overlays the centered label via `overlayBarLabel`. All four render paths (normal band color / `|color|` override / stale / placeholder) route through it. `splitBar` stays untouched.

**Tech Stack:** TypeScript, node:test + tsx, esbuild. No new deps.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-m-windowquota-bar-label-design.md` (approved 2026-08-10).
- **Bar defaults** (do not hardcode in render): `width: 8`, `filled: "▓"`, `empty: "░"` from `cfg().bar` (`src/config.ts:100`). Tests may hardcode the default for assertions.
- **Color rule:** per-char, positional. Label glyphs replace the bar cells they cover but KEEP each cell's positional color. `label:5h` and `label:▓▓` must color identically.
- **Truncation:** resolver truncates to 4 code points (`[...s].slice(0,4).join("")`); `overlayBarLabel` further truncates to fit `width` display columns. Empty/whitespace label → resolver returns `null` → badarg (drop + warn).
- **Interactions:** `valueOnly:true` → label silently ignored. Missing interval placeholder → label shown, plain. `m_countdown`/`m_quota`/`m_windowContext`/`m_windowMemUsage` untouched. `splitBar` untouched. Dispatcher skipLen stays 14.
- **No `label` in the `m_template` passthrough whitelist** (experimental — direct inline only).
- **Byte-identical regression:** with no `label`, output must be byte-identical to the current render. The existing `m_windowQuota` / `formatOneChunk` test suite is the guard.
- **Band SGR codes** for test assertions: brightGreen `\x1b[38;5;41m`, darkGreen `\x1b[38;5;29m`, red `\x1b[38;5;196m`, stale `\x1b[90m`. `strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "")` (already defined in `lineTemplate.test.ts:36`).
- **Deploy:** minimal — `npm run build` + copy `dist/index.js` into the highest cache version dir. No version bump. Per `CLAUDE.md` "Dev loop: minimal deploy".

---

### Task 1: Add failing tests for the `|label|` bar overlay

**Files:**
- Modify: `src/lineTemplate.test.ts` (insert a new describe block immediately after line 1455 — the end of the `:display override` describe block)

**Interfaces:**
- Consumes: existing test helpers already imported in the file — `renderProviderLine`, `strip`, `STALE_COLOR`, `charDisplayWidth`, `withCapturedStderr`, `__resetForTest`, `__resetUnknownModuleWarnForTest`.
- Produces: the describe block "lineTemplate — m_windowQuota experimental |label| bar overlay" that Task 2 must make pass.

- [ ] **Step 1: Insert the failing test describe block**

Insert the following block at `src/lineTemplate.test.ts` right after line 1455 (`});` that closes the `:display override` describe). The helper `intervalForTerm` is exercised through `renderProviderLine`; the `shortInterval` shape is copied verbatim from the existing tests in the same file.

```ts
// vX.X.X+ — experimental |label| bar overlay for m_windowQuota. The label
// (≤4 code points) is centered on the bar, replacing the display columns it
// covers. Color is POSITIONAL: each cell (including label glyphs) keeps the
// color the used/remaining split gives its column — so label:5h and label:▓▓
// color identically, and a label straddling the colored/plain boundary splits
// per char. valueOnly ignores the label; the placeholder bar shows it.
describe("lineTemplate — m_windowQuota experimental |label| bar overlay", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_windowQuota|label:5h at 38% used renders the label in the plain zone: '▓▓▓5h░░░ 38%'", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:5h"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 38% used → coloredSize 3 → cols 0-2 ▓ green, cols 3-7 ░ plain. Label
    // "5h" centered at cols 3-4 (both plain): `▓▓▓` green + `5h░░░` plain.
    assert.equal(strip(line), "▓▓▓5h░░░ 38%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;41m▓▓▓\x1b[0m"), `green bar run: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\x1b[38;5;41m5h"), `label must NOT be green at cols 3-4: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|label:5h at 100% used keeps the label inside the colored run: '▓▓▓5h▓▓▓ 100%'", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:5h"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 100, remainingPercent: 0, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 100% → coloredSize 8 → every cell (incl. label) is red (band [90,100]).
    assert.equal(strip(line), "▓▓▓5h▓▓▓ 100%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m▓▓▓5h▓▓▓\x1b[0m"), `whole bar+label must be one red run: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|label:mo renders '▓▓▓mo▓▓▓' at 100% used", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:mo"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 100, remainingPercent: 0, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "▓▓▓mo▓▓▓ 100%", `got: ${JSON.stringify(line)}`);
  });

  it("label over 4 code points truncates to 4: '5h7d8x' → '5h7d'", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:5h7d8x"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 100, remainingPercent: 0, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 4 chars → centered at cols 2-5: `▓▓5h7d▓▓`.
    assert.equal(strip(line), "▓▓5h7d▓▓ 100%", `got: ${JSON.stringify(line)}`);
    assert.ok(!strip(line).includes("8x"), `truncated tail leaked: ${JSON.stringify(line)}`);
  });

  it("label straddling the colored/plain boundary colors per char: 50% used '5h' → '5' green, 'h' plain", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:5h"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 50, remainingPercent: 100 - 50, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 50% → coloredSize 4 → cols 0-3 green, cols 4-7 plain. Label at cols 3-4:
    // col3 "5" green (was ▓), col4 "h" plain (was ░).
    assert.equal(strip(line), "▓▓▓5h░░░ 50%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;41m▓▓▓5\x1b[0mh"), `col3 '5' green then col4 'h' plain: ${JSON.stringify(line)}`);
  });

  it("label glyph content is irrelevant to color: label:▓▓ colors positionally at 50% used", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:▓▓"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 50, remainingPercent: 50, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 50% → coloredSize 4. Label "▓▓" at cols 3-4: col3 '▓' green (was ▓),
    // col4 '▓' plain (was ░) — glyph content never affects the positional color.
    assert.equal(strip(line), "▓▓▓▓▓░░░ 50%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;41m▓▓▓▓\x1b[0m▓"), `green run stops at col3, col4 '▓' plain: ${JSON.stringify(line)}`);
  });

  it("display:remaining renders the label on the right-colored side: '░░░5h▓▓▓ 62%'", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|display:remaining|label:5h"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // displayedPct 62 → coloredSize 5 → cols 0-2 ░ plain, cols 3-7 ▓ green
    // (colorFor(62,"remaining") → band 0 bright green). Label at cols 3-4 sits
    // on the colored side.
    assert.equal(strip(line), "░░░5h▓▓▓ 62%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;41m5h▓▓▓\x1b[0m"), `label + right fill one green run: ${JSON.stringify(line)}`);
  });

  it("wide CJK label centers by display width: '中' → '▓▓▓中▓▓▓' at 100% used", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:中"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 100, remainingPercent: 0, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(charDisplayWidth("中"), 2);
    assert.equal(strip(line), "▓▓▓中▓▓▓ 100%", `got: ${JSON.stringify(line)}`);
  });

  it("valueOnly:true ignores the label: '38%' only", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:5h|valueOnly:true"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "38%", `got: ${JSON.stringify(line)}`);
    assert.ok(!strip(line).includes("5h"), `label leaked into valueOnly: ${JSON.stringify(line)}`);
  });

  it("placeholder (missing interval) shows the label centered: '░░░mo░░░ 0%'", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|nulldrop:false|label:mo"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // placeholderGauge: used mode → 8 plain ░ cells, label at cols 3-4, STALE_COLOR wrap.
    assert.equal(strip(line), "░░░mo░░░ 0%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[90m"), `placeholder wraps in STALE_COLOR: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|label: (empty value) is a hard noop (drops and warns)", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:"] });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_windowQuota|label:5h|color:red colors the label per positional rule with the override tint", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:5h|color:red"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 50, remainingPercent: 50, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 50% → coloredSize 4 → cols 0-3 red (override), col4 "h" plain. Label at
    // cols 3-4: col3 "5" red (was ▓), col4 "h" plain (was ░).
    assert.equal(strip(line), "▓▓▓5h░░░ 50%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m▓▓▓5\x1b[0m"), `got: ${JSON.stringify(line)}`);
  });

  it("stale m_windowQuota|label:5h uses STALE_COLOR for the colored side + label char", () => {
    __resetForTest({ statuslineTemplate: ["m_windowQuota|label:5h"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 50, remainingPercent: 50, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: true, version: "",
    });
    // 50% → coloredSize 4 → cols 0-3 STALE_COLOR, col4 "h" plain.
    assert.equal(strip(line), "▓▓▓5h░░░ 50%", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[90m▓▓▓5\x1b[0m"), `stale tint on col3 '5': ${JSON.stringify(line)}`);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm they FAIL**

Run: `node --test --import tsx src/lineTemplate.test.ts --test-name-pattern="bar overlay"`

The pattern matches the new describe name's suffix (`... experimental |label| bar overlay`). Expected: all tests in the new describe FAIL (and the file reports `fail`). Reason — `label` is not yet in `INLINE_SCHEMAS.m_windowQuota` (`src/render.ts:4063`), so `parseInlineArgs` (`src/render.ts:5436`) returns `null` for the unknown arg → `badarg` → the whole module token drops → `renderProviderLine` returns `""`. Every data-present test asserts a non-empty `strip(line)`, so it fails. The `|label:|` empty-value test may already PASS (empty named value is badarg regardless of schema); that is fine.

If the pattern flag doesn't match, run the whole file: `node --test --import tsx src/lineTemplate.test.ts`. The new tests still fail; the rest of the file must still pass (do not touch anything else).

Do NOT commit in this task — the suite would be left red.

---

### Task 2: Implement `|label|` — `LABEL_PARAM`, `splitBarLabeled`, `overlayBarLabel`, and wiring

**Files:**
- Modify: `src/render.ts` — seven edits:
  1. `splitBar` at `src/render.ts:331-370` — leave as-is (exported + tested).
  2. Insert `splitBarLabeled` + `overlayBarLabel` immediately after `splitBar` (after line 370).
  3. Replace `formatOneChunk` (`src/render.ts:557-594`).
  4. Replace `formatOneChunkColored` (`src/render.ts:599-623`).
  5. Add `LABEL_PARAM` after `TERM_PARAM` (after line 3288).
  6. Update `placeholderGauge` (`src/render.ts:3446-3460`).
  7. Update `INLINE_SCHEMAS.m_windowQuota` (line 4063) and `INLINE_RENDERERS.m_windowQuota` (lines 4451-4466).

**Interfaces:**
- Consumes: `charDisplayWidth` (`src/render.ts:3969`), `cfg().bar.{width,filled,empty}`, `colorFor`, `STALE_COLOR`, `RESET`, `DisplayMode`, `ResolvedValue`, `Window`.
- Produces: `splitBarLabeled(usedPct, mode, width, label, coloredColor) → { leftChunk, rightChunk, color }` and `overlayBarLabel(cells, width, label) → void` — internal to `render.ts`, consumed by `formatOneChunk` / `formatOneChunkColored` / `placeholderGauge`.

- [ ] **Step 1: Add `splitBarLabeled` + `overlayBarLabel` after `splitBar`**

After the closing `}` of `splitBar` (line 370, before the `// Backwards-compatible simple "filled on left" bar` comment at line 372), insert:

```ts
// vX.X.X+ — experimental centered-bar label. Builds the bar as per-display-
// column cells; each cell's color is POSITIONAL (colored side = the metric-of-
// concern side), independent of glyph content. `label` (already ≤4 code points)
// is overlaid at the display-column center, replacing the cell glyphs but
// keeping each cell's positional color (so `label:5h` and `label:▓▓` color
// identically). `coloredColor` is the metric tint (band color / user |color|
// override / STALE_COLOR). No label → byte-identical to the legacy splitBar
// layout (one colored run + one plain run).
function splitBarLabeled(
  usedPct: number,
  mode: DisplayMode,
  width: number,
  label: string | undefined,
  coloredColor: string,
): { leftChunk: string; rightChunk: string; color: string } {
  const used = Math.max(0, Math.min(100, usedPct));
  const remaining = 100 - used;
  const displayed = mode === "remaining" ? remaining : used;
  const coloredSize = Math.round((displayed / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);

  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;

  const cells: { glyph: string; color: string | undefined }[] = [];
  for (let i = 0; i < width; i++) {
    const isColored = mode === "used" ? i < coloredSize : i >= plainSize;
    const glyph = mode === "used"
      ? (i < coloredSize ? filled : empty)
      : (i < plainSize ? empty : filled);
    cells.push({ glyph, color: isColored ? coloredColor : undefined });
  }

  if (label) overlayBarLabel(cells, width, label);

  // Serialize consecutive same-color cells into single SGR runs. Wide-char
  // spacer cells (glyph === "") are invisible and keep the current run intact.
  let body = "";
  let runColor: string | undefined;
  let run = "";
  const flush = () => {
    if (run !== "") body += runColor ? `${runColor}${run}${RESET}` : run;
    run = "";
  };
  for (const cell of cells) {
    if (cell.glyph === "") continue;
    if (cell.color !== runColor) {
      flush();
      runColor = cell.color;
    }
    run += cell.glyph;
  }
  flush();

  return { leftChunk: body, rightChunk: "", color: coloredColor };
}

// Overlay `label` centered on a width-cell bar (per display column). Label
// chars replace the cell glyphs but KEEP the cells' positional colors. Truncates
// the label to fit `width` display columns; wide chars (CJK/emoji) occupy 2
// columns via charDisplayWidth.
function overlayBarLabel(
  cells: { glyph: string; color: string | undefined }[],
  width: number,
  label: string,
): void {
  const kept: string[] = [];
  let labelW = 0;
  for (const ch of label) {
    const w = charDisplayWidth(ch);
    if (w === 0) continue; // control / zero-width chars render nothing
    if (labelW + w > width) break;
    kept.push(ch);
    labelW += w;
  }
  if (kept.length === 0) return;
  const start = Math.floor((width - labelW) / 2);
  let col = start;
  for (const ch of kept) {
    const w = charDisplayWidth(ch);
    cells[col] = { glyph: ch, color: cells[col].color };
    if (w === 2) {
      // A wide glyph occupies 2 display columns but renders once: blank out the
      // next column as a zero-width spacer so the bar's display width stays
      // `width` (splitBarLabeled's serializer skips empty-glyph cells).
      cells[col + 1] = { glyph: "", color: undefined };
    }
    col += w;
  }
}
```

- [ ] **Step 2: Replace `formatOneChunk`**

Replace the whole function `formatOneChunk` (`src/render.ts:557-594`) with:

```ts
function formatOneChunk(
  w: Window,
  mode: DisplayMode,
  width = cfg().bar.width,
  stale: boolean = false,
  label?: string,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  // stale=true → the WHOLE colored span (bar cells + percent tail) uses
  // STALE_COLOR ("this number is from a failed fetch"); the plain side stays
  // plain so the used/remaining shape stays readable. Inline :color| overrides
  // still win (the colored-override path routes through formatOneChunkColored).
  const coloredColor = stale ? STALE_COLOR : colorFor(displayedPct, mode);
  const bar = splitBarLabeled(usedPct, mode, width, label, coloredColor);
  return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}`;
}
```

- [ ] **Step 3: Replace `formatOneChunkColored`**

Replace the whole function `formatOneChunkColored` (`src/render.ts:599-623`) with:

```ts
// Same layout as formatOneChunk but the colored side + percentage wrap in
// `override` (used by the inline-args `|color|<c>` path on gauge modules).
// The user's color REPLACES the band-based color — the override always wins.
function formatOneChunkColored(
  w: Window,
  mode: DisplayMode,
  override: string,
  width = cfg().bar.width,
  label?: string,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const bar = splitBarLabeled(usedPct, mode, width, label, override);
  return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}`;
}
```

- [ ] **Step 4: Add `LABEL_PARAM` after `TERM_PARAM`**

Insert immediately after the closing `} as const;` of `TERM_PARAM` (line 3288), before the `// Per-module display-mode override` comment (line 3290):

```ts
// vX.X.X+ — experimental per-bar centered label (`|label|<s>`). Truncates to 4
// code points; empty/whitespace → badarg. The label's glyphs replace the
// centered bar cells (display-width aware) but each cell KEEPS its positional
// color — see splitBarLabeled / overlayBarLabel.
const LABEL_PARAM = {
  named: {
    label: (raw: string): ResolvedValue | null => {
      const s = raw.trim();
      if (s === "") return null;
      return [...s].slice(0, 4).join("");
    },
  },
} as const;
```

- [ ] **Step 5: Update `placeholderGauge`**

Replace the whole function `placeholderGauge` (`src/render.ts:3446-3460`) with:

```ts
function placeholderGauge(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
  const valueOnly = params.valueOnly === "true";
  const empty = cfg().bar.empty;
  const filled = cfg().bar.filled;
  const width = cfg().bar.width;
  const label = params.label as string | undefined;
  if (mode === "used") {
    if (valueOnly) return "0%";
    const cells: { glyph: string; color: string | undefined }[] = Array.from(
      { length: width },
      () => ({ glyph: empty, color: undefined }),
    );
    if (label) overlayBarLabel(cells, width, label);
    return `${cells.map((c) => c.glyph).join("")} 0%`;
  }
  // mode === "remaining": full filled bar, "100%".
  if (valueOnly) return "100%";
  const cells: { glyph: string; color: string | undefined }[] = Array.from(
    { length: width },
    () => ({ glyph: filled, color: undefined }),
  );
  if (label) overlayBarLabel(cells, width, label);
  return `${cells.map((c) => c.glyph).join("")} 100%`;
}
```

- [ ] **Step 6: Register `label` in the inline schema**

Edit `INLINE_SCHEMAS.m_windowQuota` (`src/render.ts:4063`) from:

```ts
  m_windowQuota: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
```

to:

```ts
  m_windowQuota: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named, ...LABEL_PARAM.named } },
```

The dispatcher skipLen at `src/render.ts:5681` stays `14` (a new named arg does not change the `m_windowQuota|` prefix length).

- [ ] **Step 7: Wire `label` through the inline renderer**

Edit `INLINE_RENDERERS.m_windowQuota` (`src/render.ts:4451-4466`). Change the body from:

```ts
  m_windowQuota: (params, ctx) => {
    // `term` picks which interval to read (default "short"; open-ended dict —
    // "monthly"/"yearly"/etc. all resolve the same way). Missing interval or no
    // percent data → placeholder.
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_windowQuota", params, ctx);
    const w = intervalToWindow(iv);
    if (!w) return placeholderWithColor("m_windowQuota", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const valueOnly = params.valueOnly === "true";
    const color = params.color as string | undefined;
    if (valueOnly) return formatPercentOnly(w, mode, color);
    if (color) return formatOneChunkColored(w, mode, color);
    return formatOneChunk(w, mode, cfg().bar.width, ctx.stale);
  },
```

to:

```ts
  m_windowQuota: (params, ctx) => {
    // `term` picks which interval to read (default "short"; open-ended dict —
    // "monthly"/"yearly"/etc. all resolve the same way). Missing interval or no
    // percent data → placeholder. `label` (experimental) centers text on the
    // bar; valueOnly strips the bar so the label is silently ignored.
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_windowQuota", params, ctx);
    const w = intervalToWindow(iv);
    if (!w) return placeholderWithColor("m_windowQuota", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const valueOnly = params.valueOnly === "true";
    const color = params.color as string | undefined;
    const label = params.label as string | undefined;
    if (valueOnly) return formatPercentOnly(w, mode, color);
    if (color) return formatOneChunkColored(w, mode, color, cfg().bar.width, label);
    return formatOneChunk(w, mode, cfg().bar.width, ctx.stale, label);
  },
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`

Expected: exit 0, no output. If TS complains about the `cells` array element type, add the explicit annotation already shown in Step 5 (`{ glyph: string; color: string | undefined }[]`).

- [ ] **Step 9: Run the new label tests — green**

Run: `node --test --import tsx src/lineTemplate.test.ts --test-name-pattern="bar overlay"`

Expected: all 13 tests PASS. If the pattern flag doesn't match, run the whole file.

- [ ] **Step 10: Run the full suite — regression gate**

Run: `npm test`

Expected: all ~1182 tests pass, including the existing `m_windowQuota` / `formatOneChunk` / placeholder tests in `src/render.test.ts`, `src/render-tokens.test.ts`, `src/lineTemplate.test.ts` (byte-identical no-label output) and `src/render-providerType.test.ts`. If any existing gauge assertion fails, the refactor broke byte-identity — stop and re-check Step 2/3.

- [ ] **Step 11: Commit**

```bash
git add src/render.ts src/lineTemplate.test.ts
git commit -m "feat(render): m_windowQuota experimental |label| centered-bar param

Positional per-char coloring via splitBarLabeled/overlayBarLabel; 4-code-point
truncation; valueOnly ignores; placeholder shows; splitBar untouched.
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Minimal deploy to the runtime cache

**Files:**
- None in the repo (deploy writes to `~/.claude/plugins/cache/...`). No version bump (`package.json` stays 1.2.0).

- [ ] **Step 1: Build**

Run: `npm run build`

Expected: `dist/index.js` (+ `dist/plugins/`) regenerated.

- [ ] **Step 2: Copy into the highest cache version dir + smoke check**

Run:

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
cp -r dist/plugins "${HIGHEST}dist/plugins"
grep -c "splitBarLabeled" "${HIGHEST}dist/index.js"
```

Expected: the final `grep -c` prints a number `> 0` (confirms the runtime bundle contains the new helper). The highest version is currently `1.2.0/` (verified 2026-08-10).

- [ ] **Step 3: Post-deploy smoke (optional but recommended)**

Run the live smoke from CLAUDE.md against the cached bundle to confirm the statusline path still boots (re-derive `HIGHEST` — shell state doesn't persist between invocations):

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
echo '{}' | ANTHROPIC_BASE_URL=http://127.0.0.1:1 ANTHROPIC_AUTH_TOKEN=x node "${HIGHEST}dist/index.js"
```

Expected: a `Resolve: n/a`-style line (unknown provider → plugin hides / falls back), no crash. This only verifies the bundle boots; the `|label|` rendering is covered by the unit tests in Task 2.

No commit in this task — the deploy targets the user-level cache, not the repo.
