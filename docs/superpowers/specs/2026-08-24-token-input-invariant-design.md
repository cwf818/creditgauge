# Token Input Invariant Correction Design

## Context

`src/session-parse.ts` currently validates the Claude Code stdin fields with:

```text
total_input_tokens == input_tokens + cache_read_input_tokens
```

Claude Code payloads can also include `cache_creation_input_tokens`. A payload such as:

```text
total_input_tokens = 79451
input_tokens = 3
cache_read_input_tokens = 79266
cache_creation_input_tokens = 182
```

is valid under the complete accounting formula, but currently emits the
`tokenTotalIn-invariant` warning because the creation-cache contribution is
omitted.

The parser already stores the field as
`TokenSnapshot.current.tokenCacheCreation`; the defect is limited to the
invariant check, diagnostic message, fallback arithmetic, and their tests and
comments.

## Goals

- Validate total input tokens against all three current-usage components.
- Treat a missing or invalid `cache_creation_input_tokens` value as `0` for
  this invariant only, as explicitly selected for this fix.
- Include the creation-cache value in warning diagnostics.
- Derive a correct `tokenIn` fallback when the complete formula is violated.
- Preserve `null` semantics for the parsed field everywhere else.
- Add regression coverage for nonzero, zero, missing, and invalid invariant
  cases without changing the render path or diagnostics gate.

## Non-goals

- Do not globally normalize `tokenCacheCreation` from `null` to `0`.
- Do not change TokenSample serialization or accumulator behavior.
- Do not alter diagnostics gating, deduplication, source name, or file layout.
- Do not refactor the parser into a general-purpose validation helper.

## Design

### Invariant calculation

At the existing invariant check in `src/session-parse.ts`, define the local
comparison value:

```ts
const cacheCreation = snap.current.tokenCacheCreation ?? 0;
```

The guard continues to require non-null `tokenTotalIn`, `tokenIn`, and
`tokenCachedIn`, because those values are necessary for the check. Creation
cache is optional and contributes zero when absent.

The violation condition becomes:

```text
tokenTotalIn != tokenIn + tokenCachedIn + cacheCreation
```

### Diagnostic message

Keep the existing level (`warning`) and source
(`tokenTotalIn-invariant`). Extend the message to print all operands:

```text
total_input_tokens=... != input_tokens(...) + cache_read_input_tokens(...) + cache_creation_input_tokens(...)
```

This makes the reported arithmetic directly auditable against the original
stdin payload.

### Fallback

When the complete invariant fails, derive the non-cache input component as:

```text
tokenIn = max(0, tokenTotalIn - tokenCachedIn - cacheCreation)
```

This preserves the current nonnegative clamp while preventing creation-cache
tokens from being counted as ordinary input tokens.

### Documentation

Update the invariant comments in `src/session-parse.ts`, `src/types.ts`, and
`src/index-parse.test.ts` to state the complete formula and the missing-field
zero policy. No user-facing documentation or schema migration is required.

## Test strategy

Extend the existing sandboxed invariant suite in
`src/index-parse.test.ts`:

1. A payload with nonzero creation cache (`3 + 79266 + 182 = 79451`) emits no
   warning.
2. A payload with nonzero creation cache and an incorrect total emits one
   warning containing all three operand labels and values.
3. The fallback subtracts both cache-read and cache-creation values.
4. A payload with creation cache omitted treats it as zero and follows the
   same formula.
5. Existing partial-input and diagnostics-gate behavior remains unchanged.

Verification will run the focused parser tests, the complete `npm test`
suite, `npm run typecheck`, and `npm run build`. Since runtime reads the cache
bundle, the built bundle will be copied into the highest installed
CreditGauge cache version and checked for the updated diagnostic identifier.
