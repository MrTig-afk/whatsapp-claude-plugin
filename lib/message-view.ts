// Pure render/retention rules for stored log lines (no I/O); split out of
// server.ts so they are testable without its connect-on-import side effects.
export type ViewableEntry = {
  user: string;
  text: string;
  ts: string;
  direction?: "in" | "out";
  by?: "owner";
  /** false = kept for context only, was never addressed to the agent. */
  routed?: false;
};

/** An inbound line still waiting for an answer. A `routed: false` line was
 *  never addressed to the agent, so it can never be waiting. The ONLY place
 *  this rule exists - getUnreplied and the catch_up counter both call it. */
export function awaitingReply(entry: {
  replied?: boolean;
  direction?: "in" | "out";
  routed?: false;
}): boolean {
  return (
    (entry.direction ?? "in") === "in" &&
    !entry.replied &&
    entry.routed !== false
  );
}

/** How long a log line lives - ONE lifetime for every line, whatever it is.
 *  An unanswered inbound used to go stale in a day while context lived a
 *  week, so the very message you had not got to yet was the first thing to
 *  disappear, and a chat you opened on day two showed replies to a question
 *  that was no longer there. A single horizon means what is in the log is
 *  what catch_up shows, both sides alike (owner, 2026-09-02).
 *  The caller may pass its own `ttlMs` (server.ts reads
 *  WHATSAPP_MESSAGE_TTL_DAYS); this stays the default so the lib is pure. */
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function keepLogLine(
  entry: { ts: string },
  now: number = Date.now(),
  ttlMs: number = MESSAGE_TTL_MS,
): boolean {
  const t = Date.parse(entry.ts);
  if (!Number.isFinite(t)) return false;
  return now - t < ttlMs;
}

/** Suffix on the sender of an entry that was never addressed to the agent. */
export const NOT_ADDRESSED = " (not addressed to Claude)";

/** How many messages per chat catch_up replays. */
export const RECENT_LIMIT = 5;

const byTs = <T extends { ts: string }>(a: T, b: T) => a.ts.localeCompare(b.ts);

/** Last `limit` entries, oldest-first. Non-mutating. */
export function recentWindow<T extends { ts: string }>(
  entries: T[],
  limit: number = RECENT_LIMIT,
): T[] {
  return [...entries].sort(byTs).slice(-limit);
}

/** The catch_up window per chat: the last `limit` lines from OTHERS and the
 *  last `limit` of the owner's/agent's own, merged oldest-first, so the
 *  owner's own texts cannot crowd out what the room said (owner, 2026-08-27). */
export function recentBothSides<
  T extends { ts: string; direction?: "in" | "out" },
>(entries: T[], limit: number = RECENT_LIMIT): T[] {
  const sorted = [...entries].sort(byTs);
  const isIn = (e: T) => (e.direction ?? "in") === "in";
  return [
    ...sorted.filter(isIn).slice(-limit),
    ...sorted.filter((e) => !isIn(e)).slice(-limit),
  ].sort(byTs);
}

/** How one entry renders. The ONLY place the owner label exists. Text is
 *  shown verbatim for every line the log still holds: an owner hand reply
 *  used to fade to "replied (text expired)" after an hour, which left every
 *  chat older than that reading one-sided - their half in full, the owner's
 *  half blanked - exactly when catch_up is wanted (owner, 2026-08-28).
 *  keepLogLine is now the whole retention story. */
export function renderLogEntry(
  entry: ViewableEntry,
  ownerName: string,
): { who: string; text: string } {
  return {
    who:
      entry.by === "owner"
        ? ownerName
        : entry.routed === false
          ? `${entry.user}${NOT_ADDRESSED}`
          : entry.user,
    text: entry.text,
  };
}
