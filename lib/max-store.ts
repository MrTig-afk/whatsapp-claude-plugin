// server.ts connects to WhatsApp on import, so the WHATSAPP_MAX_STORE parsing
// it uses lives here instead, where it is testable on its own.

export const DEFAULT_MAX_STORE = 500;

// An invalid cap is worse than no cap: Infinity or NaN never trips the ">
// MAX_STORE" eviction check, so the FIFO store grows without bound; zero or
// negative trips it on every insert, so nothing is ever retained; a
// fractional value still "works" but silently rounds down on every
// comparison and isn't what anyone typing an env var meant. Unset, blank, or
// any of those all fall back to the same default rather than needlessly
// crashing the server over one bad environment variable.
export function parseMaxStore(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_STORE;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_MAX_STORE;
  }
  return n;
}
