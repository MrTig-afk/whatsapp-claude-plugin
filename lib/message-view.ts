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
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MESSAGE_TTL_MS = 7 * DAY_MS;

/** The bounds on WHATSAPP_MESSAGE_TTL_DAYS. Neither end is arbitrary, and the
 *  LOW end is the destructive one.
 *
 *  Ceiling: the same horizon is pruneInbox's cutoff, and pruneInbox is the only
 *  thing stopping inbox/ from filling the disk one photo at a time. An
 *  unbounded value silently disables that guard.
 *
 *  Floor: the unit is DAYS, but Number() happily accepts 0.01 - about fourteen
 *  minutes. On the next hourly tick that deletes every attachment in inbox/
 *  older than fourteen minutes, including a photo whose path catch_up just
 *  handed the agent and which it is about to read, and empties messages.jsonl
 *  with it. Rejecting <= 0 is not enough; a small positive is the same
 *  accident with a friendlier-looking value. */
export const MIN_TTL_DAYS = 1;
export const MAX_TTL_DAYS = 30;

/** Resolve WHATSAPP_MESSAGE_TTL_DAYS to a horizon plus the diagnostic its
 *  caller should log. `note` is "" when there is nothing to say - the variable
 *  was unset, or its value was accepted as given. Pure so the lib stays pure:
 *  server.ts reads the environment and passes the string in. */
export function resolveTtlMs(raw: string | undefined): {
  ms: number;
  note: string;
} {
  if (raw === undefined || raw.trim() === "")
    return { ms: MESSAGE_TTL_MS, note: "" };
  // The note goes to diag.log, a newline-delimited file read back as records,
  // so the value is quoted and truncated rather than interpolated raw - a
  // value containing a newline would otherwise forge extra log lines. Same
  // standard as maskJid/neutralizeChannelTag elsewhere; owner-controlled
  // input, but this file does not make exceptions for that.
  const shown = JSON.stringify(raw).slice(0, 40);
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0)
    return {
      ms: MESSAGE_TTL_MS,
      note: `WHATSAPP_MESSAGE_TTL_DAYS=${shown} ignored (not a positive number); keeping ${MESSAGE_TTL_MS / DAY_MS} days`,
    };
  const clamped = Math.min(Math.max(days, MIN_TTL_DAYS), MAX_TTL_DAYS);
  if (clamped !== days)
    return {
      ms: clamped * DAY_MS,
      note: `WHATSAPP_MESSAGE_TTL_DAYS=${shown} clamped to ${clamped} days (allowed ${MIN_TTL_DAYS}-${MAX_TTL_DAYS}); inbox/ pruning uses the same horizon`,
    };
  return { ms: days * DAY_MS, note: "" };
}

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
