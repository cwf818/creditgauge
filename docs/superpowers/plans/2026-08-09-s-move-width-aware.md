# s_move 字符宽度感知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `s_move|pos:<n>` pad to real terminal display columns (emoji/CJK=2, ASCII=1, zero-width=0) so the `standard` preset's two `s_move` tokens can use equal `pos` values and the `|` separators stay aligned.

**Architecture:** Add an exported `charDisplayWidth(ch)` per-code-point width function to `src/render.ts` (classification: 0/1/2, with a terminal-calibrated exception map). Rewrite `visibleCellLength` to sum `charDisplayWidth` instead of returning JS string length. Change the `standard` preset's `s_move|pos:52` → `pos:51` so both scopeline lines pad to the same column.

**Tech Stack:** TypeScript, `node:test` + tsx, esbuild. No new runtime dependencies.

## Global Constraints

- **No new runtime deps.** Hand-rolled width function per the existing design note at `src/render.ts:5544` ("without pulling in a wcwidth dep").
- **Terminal calibration (2026-08-09, user-verified):** U+1F5EA (🗪) renders **1 cell** on the user's terminal; U+1F4E6 (📦) renders **2 cells**. Encode U+1F5EA as an exception; keep 📦 in the standard wide ranges.
- **Equal `s_move` pos values:** both `pos:51` in the `standard` preset (n/a test content = 48 display cells; 51 > 48 so no `cursor>=pos` badarg).
- **Git: do NOT auto-commit after tasks.** Per the project `git-commit-policy`, leave all changes uncommitted for the user. (If executing via fresh subagents that hand off across session boundaries, one commit per handoff is acceptable — coordinate with the user.)
- **Working tree already has uncommitted changes** (the `config.template.ts` fragment/preset redesign + `config.test.ts`/`render-affix.test.ts` sync from the prior task). Build on top; do not revert them.
- **Commands:** typecheck `npm run typecheck`; targeted test `node --test --import tsx src/<file>.test.ts`; full suite `npm test`; build `npm run build`.

---

### Task 1: `charDisplayWidth` — per-code-point width function + unit tests

**Files:**
- Modify: `src/render.ts` — add the function + constants just above `visibleCellLength` (line ~5553).
- Test: `src/render.test.ts` — add `charDisplayWidth` to the existing import block (lines 3-13) and append a new describe block.

**Interfaces:**
- Produces: `export function charDisplayWidth(ch: string): number` — takes a single code point (a one-code-point string as produced by `for...of`), returns 0 / 1 / 2.

- [ ] **Step 1: Write the failing test**

Add `charDisplayWidth` to the import in `src/render.test.ts`:

```ts
import {
  colorFor,
  colorForBalance,
  formatBalanceEntriesColored,
  formatResetSuffix,
  formatStaleSuffix,
  pctBar,
  renderProviderLine,
  resolveDisplayMode,
  splitBar,
  charDisplayWidth,
} from "./render.ts";
```

Append this describe block to the end of `src/render.test.ts`:

```ts
describe("charDisplayWidth (vX.X.X+)", () => {
  it("narrow / ASCII chars count 1", () => {
    assert.equal(charDisplayWidth("a"), 1);
    assert.equal(charDisplayWidth("|"), 1);
    assert.equal(charDisplayWidth(" "), 1);
    assert.equal(charDisplayWidth("▓"), 1); // EAW ambiguous → 1
  });

  it("CJK / fullwidth chars count 2", () => {
    assert.equal(charDisplayWidth("中"), 2);
    assert.equal(charDisplayWidth("あ"), 2);
    assert.equal(charDisplayWidth("한"), 2); // Hangul syllable U+D55C
    assert.equal(charDisplayWidth("！"), 2); // fullwidth U+FF01
  });

  it("emoji count 2 by default", () => {
    assert.equal(charDisplayWidth("📦"), 2); // U+1F4E6 (wide)
    assert.equal(charDisplayWidth("⚡"), 2);  // U+26A1 emoji-presentation
  });

  it("terminal-calibrated exception overrides the table", () => {
    assert.equal(charDisplayWidth("🗪"), 1); // U+1F5EA narrow exception
  });

  it("zero-width chars count 0", () => {
    assert.equal(charDisplayWidth("\\u200d"), 0); // ZWJ
    assert.equal(charDisplayWidth("\\u200b"), 0); // ZWSP
    assert.equal(charDisplayWidth("\\ufe0f"), 0); // VS16
    assert.equal(charDisplayWidth("\\u0301"), 0); // combining acute accent
  });

  it("control chars count 0", () => {
    assert.equal(charDisplayWidth("\t"), 0);
    assert.equal(charDisplayWidth("\x1b"), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/render.test.ts`
Expected: FAIL with `charDisplayWidth is not defined` (or similar — the import resolves to undefined until the function is exported).

- [ ] **Step 3: Implement `charDisplayWidth`**

Insert the following block in `src/render.ts` immediately above `function visibleCellLength(s: string): number {` (line 5553):

```ts
// vX.X.X+ — per-code-point display width for `s_move` column padding.
// Calibrated to the user's terminal (2026-08-09): 🗪 U+1F5EA renders 1
// cell (narrow) despite East Asian Width W; 📦 U+1F4E6 renders 2. The
// WIDTH_EXCEPTIONS map encodes such terminal-specific deviations and is
// extensible. Zero-width chars (combining marks, format controls like
// ZWJ/ZWNJ/ZWSP, variation selectors, soft hyphen, BOM) are classified
// via Unicode property escapes so we don't hand-maintain a giant range
// list. Wide chars use the classic wcwidth East-Asian-Wide ranges plus
// the emoji-presentation blocks. Everything else is 1.
const WIDTH_EXCEPTIONS: Record<number, number> = {
  // U+1F5EA right speech bubble renders narrow (1 cell) on the user's
  // terminal; the standard EAW table says W (2).
  0x1f5ea: 1,
};

// Unicode property escapes: M = combining marks (Mn/Mc/Me), Cf = format
// controls (ZWJ U+200D, ZWNJ U+200C, ZWSP U+200B, soft hyphen U+00AD,
// BOM U+FEFF, variation selectors U+FE00-U+FE0F), Zl/Zp = line/paragraph
// separators. All render zero-width for the column cursor.
const ZERO_WIDTH_RE = /[\p{M}\p{Cf}\p{Zl}\p{Zp}]/u;

// East Asian Wide / Fullwidth + emoji-presentation ranges. Collapsed
// from the classic wcwidth wide set + Unicode emoji-presentation data.
// U+1F5EA is NOT here — it is handled by WIDTH_EXCEPTIONS (narrow on
// the user's terminal).
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],    // Hangul Jamo
  [0x231a, 0x231b],    // ⌚ ⌛
  [0x23e9, 0x23f3],    // ⏩…⏳ (emoji-presentation subset of Misc Technical)
  [0x25fd, 0x25fe],    // ◽ ◾
  [0x2600, 0x27bf],    // Misc Symbols + Dingbats (common emoji-presentation set)
  [0x2b00, 0x2bff],    // Misc Symbols and Arrows (incl. ⭐, ➡)
  [0x2e80, 0xa4cf],    // CJK Radicals…Yi Syllables
  [0xac00, 0xd7a3],    // Hangul Syllables
  [0xf900, 0xfaff],    // CJK Compatibility Ideographs
  [0xfe10, 0xfe19],    // Vertical Forms
  [0xfe30, 0xfe6f],    // CJK Compatibility Forms
  [0xff00, 0xff60],    // Fullwidth Forms
  [0xffe0, 0xffe6],    // Fullwidth Signs
  [0x1f000, 0x1f64f],  // Mahjong…Emoticons (incl. 📦 U+1F4E6)
  [0x1f650, 0x1f67f],  // Ornamental Dingbats
  [0x1f680, 0x1f6ff],  // Transport & Map
  [0x1f780, 0x1f7ff],  // Geometric Shapes Extended
  [0x1f800, 0x1f8ff],  // Supplemental Arrows-C
  [0x1f900, 0x1f9ff],  // Supplemental Symbols & Pictographs
  [0x1fa00, 0x1faff],  // Symbols & Pictographs Extended (incl. 🪙 U+1FA99)
  [0x20000, 0x2fffd],  // CJK Ext B-F
  [0x30000, 0x3fffd],  // CJK Ext G+
];

// Display width of a single code point (a one-code-point string, as
// produced by `for...of` iteration). Returns 0 / 1 / 2.
export function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  const ex = WIDTH_EXCEPTIONS[cp];
  if (ex !== undefined) return ex;
  // Control characters (incl. ESC and TAB) and the DEL/C1 block.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO_WIDTH_RE.test(ch)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/render.test.ts`
Expected: PASS (all `charDisplayWidth` cases).

- [ ] **Step 5: No commit** (per git-commit-policy — leave uncommitted)

---

### Task 2: `visibleCellLength` width-aware + s_move emoji regression test

**Files:**
- Modify: `src/render.ts:5553-5581` — rewrite `visibleCellLength`'s return + the stale doc comment at 5539-5547.
- Test: `src/lineTemplate.test.ts` — add `charDisplayWidth` to the import block (lines 19-25) and add one `it` inside the `s_move — column pad separator (v0.9.0+)` describe (ends ~line 2608).

**Interfaces:**
- Consumes: `charDisplayWidth` from Task 1.
- Produces: `visibleCellLength` now returns display-cell width (side effect: the `standard` preset's `s_move|pos:52` pads to display col 52 on L3 while `pos:51` pads L4 to col 51 → misaligned until Task 3).

- [ ] **Step 1: Write the failing test**

Add `charDisplayWidth` to the import in `src/lineTemplate.test.ts`:

```ts
import {
  renderProviderLine,
  renderTemplate,
  setPrevTick,
  __resetPrevTickForTest,
  __resetUnknownModuleWarnForTest,
  charDisplayWidth,
} from "./render.ts";
```

Inside the `s_move — column pad separator` describe block (after the existing `"cursor resets on \n..."` `it`), add:

```ts
  it("pads by display width, not JS length, for emoji labels (vX.X.X+)", () => {
    // 🗪 renders 1 cell (U+1F5EA narrow exception), so `🗪 : x` is 5
    // display cells. s_move|pos:20 must emit 15 spaces so the next
    // chunk lands on display column 20. Under the old JS-length
    // cursor, 🗪 counted as 2 code units → only 14 spaces → the chunk
    // landed on column 19.
    __resetForTest({
      statuslineTemplate: ["m_label|🗪 : x", "s_move|pos:20"],
      lineTemplates: {},
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      const stripped = strip(line);
      let display = 0;
      for (const ch of stripped) display += charDisplayWidth(ch);
      assert.equal(
        display,
        20,
        `expected next chunk at display col 20, got col ${display}: ${JSON.stringify(stripped)}`,
      );
      assert.ok(
        stripped.endsWith(" ".repeat(20 - 5)),
        `expected 15 trailing pad spaces, got: ${JSON.stringify(stripped)}`,
      );
    } finally {
      __resetForTest();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/lineTemplate.test.ts`
Expected: FAIL — `expected next chunk at display col 20, got col 19` (old cursor counted 🗪 as 2 JS units → pad 14).

- [ ] **Step 3: Rewrite `visibleCellLength`**

In `src/render.ts`, replace the return of `visibleCellLength` (the final line `return stripped.length;` at line 5580) with:

```ts
  // vX.X.X+ — width-aware: sum per-code-point display width instead
  // of JS string length. `for...of` iterates full code points, so
  // surrogate-pair emoji are measured as one glyph (not 2 units).
  let width = 0;
  for (const ch of stripped) width += charDisplayWidth(ch);
  return width;
```

Also update the stale doc comment above the function (lines 5539-5547). Replace the paragraph that reads:

```ts
// v0.9.0+ — ANSI SGR strip + display-width counter for `s_move`.
// Strips ESC[…m (color/style) and ESC[…<letter> (cursor moves
// handled as "no width" anyway — only SGR can leak into chunks
// since renderers don't emit cursor moves). Width is JS string
// length of the stripped result; deliberately NOT wcwidth (east-
// asian wide chars count as 1, not 2). The trade-off is "good
// enough for the column-pad use case without pulling in a wcwidth
// dep" — the user's examples are all ASCII-padded, and the
// statusline's primary consumer is plain-ASCII data.
```

with:

```ts
// v0.9.0+ — ANSI SGR strip + display-width counter for `s_move`.
// Strips ESC[…m (color/style) and ESC[…<letter> (cursor moves
// handled as "no width" anyway — only SGR can leak into chunks
// since renderers don't emit cursor moves). Width is the sum of
// per-code-point DISPLAY widths via charDisplayWidth (vX.X.X+:
// emoji/CJK = 2, narrow = 1, zero-width = 0), so the s_move column
// cursor matches the terminal's actual columns instead of the old
// JS string length (which counted astral emoji as 2 code units and
// CJK BMP chars as 1 — both wrong for a terminal column).
```

- [ ] **Step 4: Run targeted + full suite to verify pass**

Run: `node --test --import tsx src/lineTemplate.test.ts` — Expected: PASS.
Run: `npm test` — Expected: ALL PASS (baseline 1169 + the tests added so far). The render-affix preset guard filters `s_move` tokens so the padding change doesn't trip it; no test asserts exact standard-preset output.

- [ ] **Step 5: No commit** (per git-commit-policy)

---

### Task 3: `standard` preset equal `s_move` pos + `|` alignment test

**Files:**
- Modify: `src/config.template.ts:319` — `"s_move|pos:52"` → `"s_move|pos:51"` (the L4 line at 327 is already 51).
- Test: `src/render-affix.test.ts` — add `charDisplayWidth` to the `renderProviderLine` import (line 32) and append an alignment `it` inside the `statusline presets compose cleanly` describe (ends ~line 313).

**Interfaces:**
- Consumes: `charDisplayWidth` from Task 1; the width-aware cursor from Task 2.
- Produces: `DEFAULT_STATUSLINE_PRESETS.standard` has both `s_move|pos:51`.

- [ ] **Step 1: Write the failing test**

Add `charDisplayWidth` to the import in `src/render-affix.test.ts`:

```ts
import { renderProviderLine, charDisplayWidth } from "./render.ts";
```

Inside the `statusline presets compose cleanly` describe block, after the existing `for (const [name, tpl] of Object.entries(PRESETS))` loop, add:

```ts
  // vX.X.X+ — the standard preset's two scopeline lines (L3 `🗪 : ` +
  // scopeline|session, L4 `📦: ` + scopeline|project) must have their
  // `|` separator at the SAME display column. s_move pads to an
  // absolute column, so width-aware measurement + equal pos values
  // (both 51) is what keeps them aligned. The display column must be
  // computed with charDisplayWidth: the two labels differ in emoji
  // width (🗪=1 vs 📦=2), so the raw JS indexOf differs even when the
  // display columns are equal.
  it("standard preset aligns both scopeline `|` at the same display column", () => {
    const out = line([...DEFAULT_STATUSLINE_PRESETS.standard], { prefixSpace: true });
    const lines = strip(out).split("\n");
    assert.ok(lines.length >= 4, `expected >=5 lines, got ${lines.length}: ${JSON.stringify(out)}`);
    const displayColOfPipe = (ln: string) => {
      const idx = ln.indexOf("|");
      assert.ok(idx > 0, `expected a pipe in line: ${JSON.stringify(ln)}`);
      let w = 0;
      for (const ch of ln.slice(0, idx)) w += charDisplayWidth(ch);
      return w;
    };
    const col3 = displayColOfPipe(lines[2]); // L3 `🗪` scopeline line
    const col4 = displayColOfPipe(lines[3]); // L4 `📦` scopeline line
    assert.equal(
      col4,
      col3,
      `expected aligned pipe (L3 col ${col3}, L4 col ${col4}): ${JSON.stringify(lines)}`,
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/render-affix.test.ts`
Expected: FAIL — `expected aligned pipe (L3 col 52, L4 col 51)` (width-aware cursor makes `pos:52` pad L3 to col 52 while `pos:51` pads L4 to col 51).

- [ ] **Step 3: Change the preset pos value**

In `src/config.template.ts`, line 319:

```ts
    "s_move|pos:51",
```

(i.e. `"s_move|pos:52"` → `"s_move|pos:51"`; line 327 is already `"s_move|pos:51"`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/render-affix.test.ts`
Expected: PASS — both pipes at display col 51.
Run: `npm test` — Expected: ALL PASS.

- [ ] **Step 5: No commit** (per git-commit-policy)

---

### Task 4: full verify + minimal deploy

**Files:**
- No source changes. Rebuild + overwrite the cache bundle + smoke-check.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: ALL PASS (baseline 1169 + the 8 new tests from Tasks 1-3).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: esbuild emits `dist/index.js`; `copy-builtin-plugins.mjs` copies deepseek/index.js + minimax/index.js.

- [ ] **Step 4: Overwrite the cache bundle (minimal deploy)**

Run:

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
echo "$HIGHEST"
cp dist/index.js "${HIGHEST}dist/index.js"
```

Expected: copies into the highest version dir (e.g. `.../1.2.0/`).

- [ ] **Step 5: Smoke-check the bundle**

Run:

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
echo "charDisplayWidth: $(grep -c 'charDisplayWidth' "${HIGHEST}dist/index.js")"
echo "s_move|pos:51 x$(grep -c 's_move|pos:51' "${HIGHEST}dist/index.js")"
echo "s_move|pos:52 x$(grep -c 's_move|pos:52' "${HIGHEST}dist/index.js")"
```

Expected: `charDisplayWidth: >0`, `s_move|pos:51 x2` (both L3 and L4 now 51), `s_move|pos:52 x0`.

> Note: use grep for these ASCII identifiers only — `grep` on this Windows host mishandles raw UTF-8 emoji, so don't grep for 🗪 directly.

- [ ] **Step 6: No commit** (per git-commit-policy). Report done + remind the user to eyeball the `standard` preset alignment on their terminal (the terminal-calibrated 🗪=1 exception is what makes it line up).
