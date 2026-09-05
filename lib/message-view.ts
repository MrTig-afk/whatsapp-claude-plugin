// Pure render/retention rules for stored log lines (no I/O); split out of
// server.ts so they are testable without its connect-on-import side effects.
import { groupAnchor, looksLikeNumber, maskNumber } from "../scripts/mask";

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
  // Truncate FIRST, then quote. Quoting first and slicing after would cut the
  // closing quote off a long value and emit an unterminated string into the
  // very records file the quoting exists to keep parseable.
  const shown = JSON.stringify(raw.slice(0, 38));
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

/** The name a chat is shown under, anywhere. Order matters and each step is
 *  there for a reason:
 *
 *  1. A group's own subject - the first one in the window that is not just the
 *     chat id wearing a subject's clothing. resolveGroupName falls back to the
 *     raw jid when the metadata lookup times out or its failure cooldown is
 *     active, and lines persisted during that window carry it as `group_name`.
 *     For a legacy `<creator-number>-<timestamp>@g.us` group that is the
 *     creator's full phone number. Falling through to step 3 puts it through
 *     groupAnchor instead. The persist paths are guarded too, but only from now
 *     on - this covers what is already on disk. Deliberately NOT also filtered
 *     by looksLikeNumber: that rejects any run of six digits, so real subjects
 *     like "Sprint 2026-09-05" would lose their name, and the only bad value
 *     resolveGroupName can produce is the chat id, which is already excluded.
 *  2. For a DM ONLY, the name of someone who wrote in the chat - and only if it
 *     does not look like a phone number. `user` is displaySenderName's output,
 *     and that falls back to the jid's user part when the sender has no
 *     WhatsApp profile name, so an unsaved contact would otherwise be printed
 *     as a full raw number.
 *
 *     A GROUP never takes this step. Labelling a group with whichever member
 *     happens to be first in the window makes it indistinguishable from a DM
 *     with that person, and the label then CHANGES between sessions as the
 *     window slides to a different speaker. That is not hypothetical: when a
 *     metadata lookup times out its cooldown is five minutes, so a whole run of
 *     messages carries no subject at all.
 *  3. A masked form of the chat id. groupAnchor leaves a modern
 *     `120363...@g.us` intact and masks only the phone segment of a legacy
 *     one; maskNumber keeps the last four digits of a DM.
 *
 *  There is no fourth step and no branch that returns a bare number. */
export function chatDisplayName(
  entries: { group_name?: string; direction?: "in" | "out"; user?: string }[],
  chatId: string,
): string {
  // First USABLE subject, not merely the first. A group whose metadata
  // lookup timed out on the oldest line in the window but succeeded later
  // has its real name sitting in a later entry.
  const group = entries.find(
    (e) => e.group_name && e.group_name !== chatId,
  )?.group_name;
  if (group) return group;
  if (chatId.endsWith("@g.us")) return groupAnchor(chatId);
  const sender = entries.find((e) => (e.direction ?? "in") === "in")?.user;
  if (sender && !looksLikeNumber(sender)) return sender;
  return maskNumber(chatId);
}

export type ChatCount = {
  name: string;
  unreplied: number;
  /** Whether to mark this chat with a WhatsApp-style `@`. TRUE ONLY FOR A
   *  MENTION-GATED GROUP (owner, 2026-09-05). In an ungated group every
   *  message routes to us, so an always-on `@` would be technically true and
   *  carry no information at all - the marker is worth having precisely
   *  because it is selective. Never set for a DM. */
  mentionGated: boolean;
};

/** Session start: how many are waiting, per chat, and nothing else. No message
 *  text appears here at all - that is what naming one chat is for. A chat with
 *  recent traffic but nothing unreplied is omitted entirely rather than listed
 *  as 0, so the list is only ever things that want the owner.
 *
 *  Sorted most-unreplied first, then alphabetically, so the loudest room is at
 *  the top and the order is stable between sessions.
 *
 *  Returns "" when nothing is waiting; the caller decides what to say instead,
 *  because it also knows whether there are open tasks to show.
 *
 *  ponytail: aligns on `name.length`, i.e. UTF-16 code units, so a chat name
 *  with emoji or CJK drifts by a column or two. displayWidth() in
 *  scripts/picker.ts does this properly, but importing it here would drag a
 *  raw-mode TUI into a pure module. Move displayWidth into lib/ and use it if
 *  the misalignment ever actually bothers anyone. */
export function formatChatCounts(chats: ChatCount[]): string {
  const listed = chats
    .filter((c) => c.unreplied > 0)
    .sort((a, b) => b.unreplied - a.unreplied || a.name.localeCompare(b.name));
  if (listed.length === 0) return "";
  const width = Math.max(...listed.map((c) => c.name.length));
  return listed
    .map(
      (c) =>
        // The marker is GLUED to the count ("@12", not "@  12"). Chat names
        // are peer-controlled and safeName does not strip "@", so a group
        // innocently called "Standup @ 9" would otherwise carry an @ in a
        // column no reader can tell from the marker. Adjacent to the trailing
        // number it is unambiguous: the marker is the character immediately
        // before the count, and nothing else on the line can be.
        `${c.name.padEnd(width)}   ${c.mentionGated ? "@" : " "}${c.unreplied}`,
    )
    .join("\n");
}

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
