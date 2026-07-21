// URL normalization utilities shared between providers.ts (URL matching)
// and status-store.ts (base_url stamp on JSONL rows).

// Normalize a URL to a canonical form for equality comparison.
// Uses URL constructor for structural normalization, then additionally
// lowercases the full string (covering path case too, matching the
// case-insensitive semantics of compareUrl). Returns the raw string
// on parse failure so callers never lose a valid-but-unexpected URL.
export function normalizeUrl(raw: string): string {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    // Strip default ports (80 for http, 443 for https)
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    // Strip trailing slash from non-root pathname
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.search = "";
    url.hash = "";
    // Lowercase the full output to match case-insensitive path semantics
    return url.toString().toLowerCase();
  } catch {
    return raw;
  }
}
