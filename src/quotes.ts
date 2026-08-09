// Inspirational-quote pool + per-character rainbow/hue helpers backing the
// m_quote module. QUOTES is a curated list of 100+ short bilingual (EN + 中文)
// phrases with no attribution strings — a "— Confucius" tail would dominate
// the narrow statusline.
//
// parseFreq(raw) → QuoteFreq: single-unit time format `<digits><unit>`
// (unit ∈ d/h/m/s), bare unit = 1<unit> (`h` ≡ `1h`); multi-unit forms like
// "2h10m" are rejected (use "130m"). pickQuote(freq, nowMs) is deterministic
// per frequency window; when freq.ms divides one day the boundary anchors to
// UTC midnight, otherwise it rolls at Unix-epoch multiples. buildRainbow /
// buildHue wrap text in per-char 256-color SGR.
//
// All functions are PURE (no Date.now / Math.random / I/O) so the same
// (freq, nowMs, text, seed) yields the same bytes every tick.

// ----- Quote pool -----
//
// Const array (not a Set) so tests can index directly. Entries ≤ 50 chars
// keep a quote + the rest of the statusline within one 80-col row.
//
// `author` is optional (null/blank → renderer emits `~<quote>~` with no
// `--<author>` suffix). `lang` lets `|lang|<csv>` filter rotation to one
// language; empty filter = any language eligible.
export interface QuoteEntry {
  readonly author: string | null;
  readonly quote: string;
  readonly lang: string;
}

// Defaults: English (lang="en") and 中文 (lang="zh"). `author` is null for
// the bulk of the table (folk wisdom / untraceable); set it where the source
// is well-known (Shakespeare, Lincoln, MLK, …).
const EN = (q: string, author: string | null = null): QuoteEntry => ({
  author,
  quote: q,
  lang: "en",
});
const ZH = (q: string, author: string | null = null): QuoteEntry => ({
  author,
  quote: q,
  lang: "zh",
});

export const QUOTES: readonly QuoteEntry[] = [
  // English (1-60)
  EN("Stay hungry, stay foolish."),
  EN("The only way out is through."),
  EN("Done is better than perfect."),
  EN("Move fast and fix things."),
  EN("Make it work, make it right, make it fast."),
  EN("Premature optimization is the root of all evil."),
  EN("Talk is cheap. Show me the code."),
  EN("Simplicity is the ultimate sophistication."),
  EN("Programs must be written for people to read."),
  EN("First, solve the problem. Then, write the code."),
  EN("It's not a bug, it's an undocumented feature."),
  EN("Two hard things: cache invalidation, naming things."),
  EN("Weeks of coding can save you hours of planning."),
  EN("The best error message is the one that never shows up."),
  EN("If you can dream it, you can do it."),
  EN("Believe you can and you're halfway there."),
  EN("The harder you work, the luckier you get."),
  EN("Quality is not an act, it is a habit."),
  EN("Action is the foundational key to all success."),
  EN("What we think, we become."),
  EN("Well done is better than well said."),
  EN("The future depends on what you do today."),
  EN("Discipline is the bridge between goals and accomplishment."),
  EN("Do the hard jobs first. The easy jobs will take care of themselves."),
  EN("Don't watch the clock; do what it does. Keep going."),
  EN("Success is the sum of small efforts repeated day in and day out."),
  EN("Start where you are. Use what you have. Do what you can."),
  EN("It always seems impossible until it's done."),
  EN("Focus on being productive instead of busy."),
  EN("The secret of getting ahead is getting started."),
  EN("Don't let yesterday take up too much of today."),
  EN("You learn more from failure than from success."),
  EN("It's not whether you get knocked down, it's whether you get up."),
  EN("If you are working on something exciting, it will keep you motivated."),
  EN("Success is not in what you have, but who you are."),
  EN("The way to get started is to quit talking and begin doing."),
  EN("Innovation distinguishes between a leader and a follower."),
  EN("Life is what happens when you're busy making other plans."),
  EN("The mind is everything. What you think you become."),
  EN("Strive not to be a success, but rather to be of value."),
  EN("Two roads diverged in a wood, and I took the one less traveled."),
  EN("That which does not kill us makes us stronger."),
  EN("Be the change that you wish to see in the world."),
  EN("The best time to plant a tree: 20 years ago. Second best: now."),
  EN("An unexamined life is not worth living."),
  EN("I think, therefore I am."),
  EN("The unexamined life is not worth living."),
  EN("Knowledge is power."),
  EN("To be or not to be, that is the question."),
  EN("I have a dream."),
  EN("The only thing we have to fear is fear itself."),
  EN("Float like a butterfly, sting like a bee."),
  EN("I'll be back."),
  EN("Houston, we have a problem."),
  EN("May the Force be with you."),
  EN("Elementary, my dear Watson."),
  EN("Eureka!"),
  EN("Veni, vidi, vici."),
  EN("Carpe diem."),
  EN("Memento mori."),
  EN("Cogito ergo sum."),
  // 中文 (61-110)
  ZH("千里之行，始于足下。"),
  ZH("行胜于言。"),
  ZH("学而时习之，不亦说乎。"),
  ZH("天行健，君子以自强不息。"),
  ZH("地势坤，君子以厚德载物。"),
  ZH("路漫漫其修远兮，吾将上下而求索。"),
  ZH("不积跬步，无以至千里；不积小流，无以成江海。"),
  ZH("工欲善其事，必先利其器。"),
  ZH("业精于勤，荒于嬉；行成于思，毁于随。"),
  ZH("宝剑锋从磨砺出，梅花香自苦寒来。"),
  ZH("少壮不努力，老大徒伤悲。"),
  ZH("一寸光阴一寸金，寸金难买寸光阴。"),
  ZH("三人行，必有我师焉。"),
  ZH("知之为知之，不知为不知，是知也。"),
  ZH("温故而知新，可以为师矣。"),
  ZH("学而不思则罔，思而不学则殆。"),
  ZH("己所不欲，勿施于人。"),
  ZH("得道多助，失道寡助。"),
  ZH("生于忧患，死于安乐。"),
  ZH("富贵不能淫，贫贱不能移，威武不能屈。"),
  ZH("苟利国家生死以，岂因祸福避趋之。"),
  ZH("天下兴亡，匹夫有责。"),
  ZH("人生自古谁无死，留取丹心照汗青。"),
  ZH("海纳百川，有容乃大；壁立千仞，无欲则刚。"),
  ZH("一万年太久，只争朝夕。"),
  ZH("数风流人物，还看今朝。"),
  ZH("星星之火，可以燎原。"),
  ZH("没有调查就没有发言权。"),
  ZH("实事求是。"),
  ZH("实践是检验真理的唯一标准。"),
  ZH("世上无难事，只要肯登攀。"),
  ZH("为中华之崛起而读书。"),
  ZH("我自横刀向天笑，去留肝胆两昆仑。"),
  ZH("与天地兮比寿，与日月兮齐光。"),
  ZH("莫愁前路无知己，天下谁人不识君。"),
  ZH("长风破浪会有时，直挂云帆济沧海。"),
  ZH("会当凌绝顶，一览众山小。"),
  ZH("天生我材必有用，千金散尽还复来。"),
  ZH("仰天大笑出门去，我辈岂是蓬蒿人。"),
  ZH("人生如逆旅，我亦是行人。"),
  ZH("此心安处是吾乡。"),
  ZH("纸上得来终觉浅，绝知此事要躬行。"),
  ZH("问渠那得清如许，为有源头活水来。"),
  ZH("少年辛苦终身事，莫向光阴惰寸功。"),
  ZH("博观而约取，厚积而薄发。"),
  ZH("沉舟侧畔千帆过，病树前头万木春。"),
  ZH("山重水复疑无路，柳暗花明又一村。"),
  ZH("不畏浮云遮望眼，自缘身在最高层。"),
  ZH("咬定青山不放松，立根原在破岩中。"),
  EN("Stay weird, stay hungry."),
  EN("Make today count."),
  EN("Less talk, more code."),
  EN("Ship it."),
  EN("Fail fast, learn faster."),
  EN("Code is read more than written."),
  EN("Refactor early, refactor often."),
  EN("Tests are a love letter to future you."),
  EN("Every expert was once a beginner."),
  EN("Move fast, fix things."),
  EN("The best time to start was yesterday."),
  ZH("今天最好的表现，是明天最低的要求。"),
  ZH("越努力，越幸运。"),
  ZH("不怕慢，就怕站。"),
  ZH("一万小时定律。"),
];

// ----- Frequency → bucket size -----
//
// Bucket = the smallest time unit at which the displayed quote can change;
// two ticks in the same bucket show the same quote.
//
// Grammar (single-unit time format): `<digits><unit>` (e.g. "12h", "30m",
// "130m") or a bare unit letter = 1<unit> ("h" ≡ "1h"); unit ∈ d/h/m/s.
// Anything else (multi-unit "2h10m", unknown unit, zero, overflow, empty,
// "h10") → null; the renderer drops the token with a one-shot stderr warn.
//
// Anchoring: if bucketMs divides one day (86_400_000) the boundary sits at
// UTC midnight ("12h" rolls at 00:00/12:00 UTC); otherwise it rolls at
// Unix-epoch multiples. "7d" divides (UTC-midnight); "13h" does not (epoch).
export type QuoteFreqUnit = "d" | "h" | "m" | "s";

// Parsed freq spec. Carrying the unit-ms separately (instead of a
// precomputed single number) lets the renderer pick the right anchor
// strategy at call time without re-parsing.
export interface QuoteFreq {
  readonly count: number;
  readonly unit: QuoteFreqUnit;
  readonly ms: number;
}

const UNIT_MS: Readonly<Record<QuoteFreqUnit, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

// Upper bound on count: 1_000_000 of any unit ("1000000s" ≈ 11.6 days, …
// "1000000d" ≈ 2738 years). Bigger is rejected so the seed index can't
// overflow Math.floor(nowMs / bucket).
const MAX_COUNT = 1_000_000;

export function parseFreq(raw: string): QuoteFreq | null {
  if (raw === "") return null;
  // Shorthand: bare unit letter → count=1.
  if (raw === "d" || raw === "h" || raw === "m" || raw === "s") {
    const ms = UNIT_MS[raw];
    return { count: 1, unit: raw, ms };
  }
  // Numeric form: <digits><unit>. Must end in a single unit letter;
  // no multi-unit, no leading sign, no whitespace.
  const unit = raw[raw.length - 1];
  if (unit !== "d" && unit !== "h" && unit !== "m" && unit !== "s") {
    return null;
  }
  const digits = raw.slice(0, -1);
  if (digits === "") return null;
  // Reject "01" / "07" — explicit leading-zero policy. Keeps the
  // grammar tight; users who type "1h" should not be silently
  // redirected through "01h".
  if (digits.length > 1 && digits[0] === "0") return null;
  if (!/^[0-9]+$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n === 0 || n > MAX_COUNT) return null;
  const u = unit as QuoteFreqUnit;
  return { count: n, unit: u, ms: n * UNIT_MS[u] };
}

// True when bucketMs divides one day exactly (UTC-midnight alignment):
// "12h", "6h", "30m", "60s", "7d" qualify; "13h" does not.
export function utcAnchored(bucketMs: number): boolean {
  if (bucketMs <= 0) return false;
  return 86_400_000 % bucketMs === 0;
}

// Pure: seed = floor(nowMs / bucket), mapped into the pool via modulo. Same
// (freq, nowMs) → same index ("stays stable within a window"). Works for both
// anchor modes: rolling (epoch multiples) and UTC-anchored (bucket divides
// one day, so within-day times land on the same pool residue).
export function quoteIndex(freq: QuoteFreq, nowMs: number): number {
  const bucket = freq.ms;
  const seed = Math.floor(nowMs / bucket);
  // Handle negative seeds via modulo: JS's % preserves sign of the
  // dividend. Map to a non-negative residue.
  const len = QUOTES.length;
  return ((seed % len) + len) % len;
}

// Pick a quote for the given freq + now. Convenience wrapper that
// returns the string. Stable per window.
export function pickQuote(freq: QuoteFreq, nowMs: number): string {
  return QUOTES[quoteIndex(freq, nowMs)]!.quote;
}

// Sanitize a quote: (1) CRLF/TAB → single space, drop other C0 controls +
// DEL; (2) collapse whitespace runs. Truncation is a separate pass (see
// truncateQuote); pass max=0 to opt out.
export function sanitizeQuote(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const code = c.charCodeAt(0);
    // CRLF / TAB → single space. \v, \f stay as-is (handled below).
    if (c === "\n" || c === "\r" || c === "\t") {
      out += " ";
      continue;
    }
    // C0 controls (including \v \f) + DEL: drop.
    if (code < 32 || code === 127) continue;
    out += c;
  }
  // Collapse multiple whitespace runs to a single space. Done as
  // a post-pass so the sanitize pass can keep its per-char shape.
  return out.replace(/ {2,}/g, " ");
}

// Coarse CJK block ranges: these chars consume 2 budget units (中文 30 chars
// ≈ 英文 60 under a 60-budget cap); anything else consumes 1.
export function quoteWeight(code: number): number {
  // CJK Unified Ideographs + extension blocks
  if (code >= 0x4e00 && code <= 0x9fff) return 2;
  if (code >= 0x3400 && code <= 0x4dbf) return 2; // CJK Ext A
  if (code >= 0x20000 && code <= 0x2a6df) return 2; // CJK Ext B
  if (code >= 0x2a700 && code <= 0x2b73f) return 2; // CJK Ext C
  if (code >= 0x2b740 && code <= 0x2b81f) return 2; // CJK Ext D
  if (code >= 0x2b820 && code <= 0x2ceaf) return 2; // CJK Ext E-F
  // Hangul Syllables + Jamo
  if (code >= 0xac00 && code <= 0xd7af) return 2;
  if (code >= 0x1100 && code <= 0x11ff) return 2; // Hangul Jamo
  // Hiragana, Katakana, Katakana Phonetic Extensions
  if (code >= 0x3040 && code <= 0x309f) return 2;
  if (code >= 0x30a0 && code <= 0x30ff) return 2;
  if (code >= 0x31f0 && code <= 0x31ff) return 2;
  // Fullwidth / Halfwidth / punctuation slabs (CJK)
  if (code >= 0xff00 && code <= 0xffef) return 2;
  // CJK compatibility ideographs + symbols
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0x2f00 && code <= 0x2fdf) return 2;
  // Anything else → ASCII or Latin-counts-1.
  return 1;
}

// Sanitize + truncate to the CJK-weighted budget (CJK=2, latin=1, total ≤
// max; max<=0 = sanitize only). Appends `...` when the body was clipped.
// Single O(n) walk over code points — emoji / punctuation count 1 like
// any non-CJK char.
export function truncateQuote(text: string, max: number): string {
  const clean = sanitizeQuote(text);
  if (max <= 0) return clean;
  let budget = 0;
  let cutAt = -1;
  for (let i = 0; i < clean.length; i++) {
    const w = quoteWeight(clean.charCodeAt(i));
    if (budget + w > max) {
      cutAt = i;
      break;
    }
    budget += w;
  }
  if (cutAt === -1) return clean;
  return clean.slice(0, cutAt) + "...";
}

// Full QuoteEntry for the current window, so the renderer can surface an
// `author` suffix (`~<quote>--<author>~`); null author elides the half.
export function pickQuoteEntry(
  freq: QuoteFreq,
  nowMs: number,
): QuoteEntry {
  return QUOTES[quoteIndex(freq, nowMs)]!;
}

// Language-filtered picker for `m_quote|lang|<csv>`. Walks forward from the
// current window index to the first matching lang, bounded to one full table
// (termination). Empty / unknown list falls back to pickQuoteEntry.
export function pickQuoteEntryFiltered(
  freq: QuoteFreq,
  nowMs: number,
  langs: readonly string[],
): QuoteEntry {
  if (langs.length === 0) return pickQuoteEntry(freq, nowMs);
  const start = quoteIndex(freq, nowMs);
  for (let off = 0; off < QUOTES.length; off++) {
    const entry = QUOTES[(start + off) % QUOTES.length]!;
    if (langs.includes(entry.lang)) return entry;
  }
  return QUOTES[start]!;
}

// ----- Color helpers -----
//
// Back m_quote:color values: "rainbow" → buildRainbow(text, 0);
// "rand-rainbow" → buildRainbow(text, seed+1); "hue" → buildHue(text, seed).
// `seed` is the quoteIndex bucket, so same bucket → same color. Wired up in
// src/render.ts.

const RESET = "\x1b[0m";

// 6 hues sampled evenly from the 6×6×6 cube, picked for visibility on dark
// AND light terminals: 39 (cyan), 45 (blue), 99 (purple), 201 (magenta),
// 208 (orange), 220 (yellow). Reused cyclically.
const RAINBOW_PALETTE: readonly number[] = [
  39, 45, 99, 201, 208, 220,
];

// Build a per-character rainbow-wrapped string. Each char gets
// `\x1b[38;5;{n}m` + char + RESET. The seed offsets the rotation so
// `rand-rainbow` doesn't have to start at hue 0 every window.
export function buildRainbow(text: string, seed: number): string {
  if (text === "") return "";
  const out: string[] = [];
  const len = RAINBOW_PALETTE.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // Skip newlines and joiners (this would break the SGR wrapping
    // by introducing unclosed color runs). Preserve them as-is and
    // emit a RESET to close any open run.
    if (ch === "\n" || ch === "\r") {
      out.push(ch);
      continue;
    }
    const idx = ((i + seed) % len + len) % len;
    const color = RAINBOW_PALETTE[idx]!;
    out.push(`\x1b[38;5;${color}m${ch}${RESET}`);
  }
  return out.join("");
}

// Single-hue wrap: hue from a DJB2 hash of the text (same text → same hue;
// seed ignored intentionally). Sampled from the 6×6×6 cube.
export function buildHue(text: string, _seed: number): string {
  if (text === "") return "";
  // DJB2 — small, deterministic, no need for crypto here.
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  // Sample the 6×6×6 cube (rows 2-5 of each channel) so colors stay saturated.
  const idx = 16 + ((Math.abs(h) % 216) | 0); // 16..231
  return `\x1b[38;5;${idx}m${text}${RESET}`;
}