import { describe, expect, test } from "bun:test";
import {
  awaitingReply,
  type ChatCount,
  chatDisplayName,
  DAY_MS,
  formatChatCounts,
  keepLogLine,
  MAX_TTL_DAYS,
  MIN_TTL_DAYS,
  MESSAGE_TTL_MS,
  NOT_ADDRESSED,
  recentBothSides,
  recentWindow,
  renderLogEntry,
  resolveTtlMs,
  type ViewableEntry,
} from "./message-view";

const now = Date.parse("2026-08-27T09:00:00.000Z");
const minutesAgo = (m: number) => new Date(now - m * 60 * 1000).toISOString();
const hoursAgo = (h: number) =>
  new Date(now - h * 60 * 60 * 1000).toISOString();

// An owner hand-reply as persistMessage logs it; `over` varies one field.
const owner = (over: Partial<ViewableEntry> = {}): ViewableEntry => ({
  user: "self",
  text: "see you at six",
  ts: minutesAgo(30),
  direction: "out",
  by: "owner",
  ...over,
});

describe("renderLogEntry", () => {
  test("owner entry, 30 minutes old: text intact", () => {
    expect(renderLogEntry(owner(), "Kaushik")).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("owner entry, 6 days old: text still intact, no expiry at any age", () => {
    expect(renderLogEntry(owner({ ts: hoursAgo(6 * 24) }), "Kaushik")).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("owner entry with an unparseable ts: ts is not read, text intact", () => {
    expect(renderLogEntry(owner({ ts: "not-a-date" }), "Kaushik")).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("bot out entry, 25 hours old: never expires, who stays You", () => {
    const entry: ViewableEntry = {
      user: "You",
      text: "on my way",
      ts: hoursAgo(25),
      direction: "out",
    };
    expect(renderLogEntry(entry, "Kaushik")).toEqual({
      who: "You",
      text: "on my way",
    });
  });

  test("contact in entry, 25 hours old: never expires, who is the contact", () => {
    const entry: ViewableEntry = {
      user: "Ravi",
      text: "sounds good",
      ts: hoursAgo(25),
      direction: "in",
    };
    expect(renderLogEntry(entry, "Kaushik")).toEqual({
      who: "Ravi",
      text: "sounds good",
    });
  });

  test("routed:false group entry: who carries the not-addressed suffix, text intact, never expires", () => {
    const entry: ViewableEntry = {
      user: "Ravi",
      text: "meeting moved to 3",
      ts: hoursAgo(25),
      direction: "in",
      routed: false,
    };
    expect(renderLogEntry(entry, "Kaushik")).toEqual({
      who: `Ravi${NOT_ADDRESSED}`,
      text: "meeting moved to 3",
    });
  });

  test("owner entry is never marked not-addressed even with routed:false present", () => {
    const entry = owner({ user: "Kaushik N", text: "ok", routed: false });
    expect(renderLogEntry(entry, "Kaushik").who).toBe("Kaushik");
  });
});

describe("awaitingReply", () => {
  test("inbound, unreplied: waiting", () => {
    expect(awaitingReply({ replied: false, direction: "in" })).toBe(true);
  });
  test("legacy line with no direction: treated as inbound", () => {
    expect(awaitingReply({ replied: false })).toBe(true);
  });
  test("routed:false: never waiting, even unreplied", () => {
    expect(
      awaitingReply({ replied: false, direction: "in", routed: false }),
    ).toBe(false);
  });
  test("outbound or replied: not waiting", () => {
    expect(awaitingReply({ replied: false, direction: "out" })).toBe(false);
    expect(awaitingReply({ replied: true, direction: "in" })).toBe(false);
  });
});

describe("recentBothSides", () => {
  test("4 own texts no longer crowd out the one thing the room said", () => {
    const entries = [
      { ts: hoursAgo(9), direction: "in" as const, n: "them-old" },
      { ts: hoursAgo(8), direction: "out" as const, n: "me1" },
      { ts: hoursAgo(7), direction: "out" as const, n: "me2" },
      { ts: hoursAgo(6), direction: "out" as const, n: "me3" },
      { ts: hoursAgo(5), direction: "out" as const, n: "me4" },
      { ts: hoursAgo(4), direction: "out" as const, n: "me5" },
    ];
    // Plain window of 5 would drop "them-old"; both-sides keeps it.
    expect(recentWindow(entries, 5).map((e) => e.n)).not.toContain("them-old");
    expect(recentBothSides(entries, 5).map((e) => e.n)).toEqual([
      "them-old",
      "me1",
      "me2",
      "me3",
      "me4",
      "me5",
    ]);
  });

  test("each side is capped at limit, merged oldest-first, legacy lines count as theirs", () => {
    const entries: { ts: string; direction?: "in" | "out"; n: number }[] = [];
    for (let i = 1; i <= 8; i++) entries.push({ ts: hoursAgo(20 - i), n: i }); // theirs
    for (let i = 1; i <= 8; i++)
      entries.push({ ts: hoursAgo(10 - i), direction: "out", n: 100 + i });
    const got = recentBothSides(entries, 5).map((e) => e.n);
    expect(got).toEqual([4, 5, 6, 7, 8, 104, 105, 106, 107, 108]);
  });
});

// keepLogLine's parameter is `{ ts: string }` - it reads nothing else. These
// tests deliberately pass the other fields a real log line carries, to prove
// they are ignored now that the two-lifetime branch is gone. A bare object
// literal cannot say that: TypeScript's excess-property check rejects a fresh
// literal with extra keys (TS2353). This widens the literal at the call site
// without widening the function's own contract.
const logLine = (e: {
  ts: string;
  direction?: "in" | "out";
  routed?: false;
  replied?: boolean;
  by?: "owner";
}): { ts: string } => e;

describe("keepLogLine", () => {
  test("ONE horizon: an unanswered inbound lives the same 7 days as everything else", () => {
    // Regression for #20. An unanswered inbound used to die at 24h, so the
    // message you had not got to yet was the first thing to vanish.
    expect(
      keepLogLine(logLine({ ts: hoursAgo(25), direction: "in" }), now),
    ).toBe(true);
    expect(
      keepLogLine(logLine({ ts: hoursAgo(6 * 24), direction: "in" }), now),
    ).toBe(true);
    expect(
      keepLogLine(logLine({ ts: hoursAgo(8 * 24), direction: "in" }), now),
    ).toBe(false);
  });
  test("every other kind of line keeps the same 7 days", () => {
    const sixDays = hoursAgo(6 * 24);
    const eightDays = hoursAgo(8 * 24);
    for (const entry of [
      { ts: sixDays, direction: "in" as const, routed: false as const },
      { ts: sixDays, direction: "in" as const, replied: true },
      { ts: sixDays, direction: "out" as const },
      { ts: sixDays, direction: "out" as const, by: "owner" as const },
    ]) {
      expect(keepLogLine(entry, now)).toBe(true);
    }
    expect(
      keepLogLine(
        logLine({ ts: eightDays, direction: "in", routed: false }),
        now,
      ),
    ).toBe(false);
    expect(
      keepLogLine(
        logLine({ ts: eightDays, direction: "out", by: "owner" }),
        now,
      ),
    ).toBe(false);
  });
  test("a caller-supplied ttl wins over the default (WHATSAPP_MESSAGE_TTL_DAYS)", () => {
    const day = 24 * 60 * 60 * 1000;
    const tenDays = hoursAgo(10 * 24);
    expect(keepLogLine(logLine({ ts: tenDays, direction: "in" }), now)).toBe(
      false,
    );
    expect(
      keepLogLine(logLine({ ts: tenDays, direction: "in" }), now, 14 * day),
    ).toBe(true);
    expect(
      keepLogLine(logLine({ ts: hoursAgo(2), direction: "in" }), now, 1 * day),
    ).toBe(true);
  });
  test("an unparseable ts is dropped whatever the ttl", () => {
    expect(keepLogLine({ ts: "nope" }, now)).toBe(false);
  });
});

describe("recentWindow", () => {
  test("8 entries in shuffled ts order, limit 5: returns the 5 newest, ascending ts", () => {
    const entries = [3, 7, 1, 8, 2, 6, 4, 5].map((n) => ({
      ts: hoursAgo(n),
      n,
    }));
    const input = [...entries];
    const result = recentWindow(entries, 5);
    expect(result.map((e) => e.n)).toEqual([5, 4, 3, 2, 1]);
    // ascending ts (oldest of the kept window first)
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].ts.localeCompare(result[i].ts)).toBeLessThan(0);
    }
    // input array unmodified
    expect(entries).toEqual(input);
  });
});

describe("resolveTtlMs", () => {
  test("unset or blank keeps the 7-day default and says nothing", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(resolveTtlMs(raw)).toEqual({ ms: MESSAGE_TTL_MS, note: "" });
    }
  });

  test("a plain positive value is taken as given, with no diagnostic", () => {
    expect(resolveTtlMs("14")).toEqual({ ms: 14 * DAY_MS, note: "" });
  });

  test("both boundaries are inclusive - 1 and 30 are accepted, not clamped", () => {
    for (const d of [MIN_TTL_DAYS, MAX_TTL_DAYS]) {
      expect(resolveTtlMs(String(d))).toEqual({ ms: d * DAY_MS, note: "" });
    }
  });

  test("above the ceiling is clamped, and says so", () => {
    // The disk guard is the point: pruneInbox shares this horizon, so an
    // unbounded value would silently switch it off.
    const r = resolveTtlMs("3650");
    expect(r.ms).toBe(MAX_TTL_DAYS * DAY_MS);
    expect(r.note).toContain("clamped");
    expect(r.note).toContain("inbox/");
  });

  test("a SMALL POSITIVE value is clamped up, not taken as given", () => {
    // The destructive end. The unit is days, but Number() accepts 0.01 - about
    // fourteen minutes. Unclamped, the next hourly tick deletes every
    // attachment in inbox/ older than that, including a photo whose path
    // catch_up just handed the agent, and empties messages.jsonl with it.
    // Rejecting <= 0 does not cover this; 0.01 looks like a real setting.
    for (const raw of ["0.01", "0.5"]) {
      const r = resolveTtlMs(raw);
      expect(r.ms).toBe(MIN_TTL_DAYS * DAY_MS);
      expect(r.note).toContain("clamped");
    }
  });

  test("junk and non-positive values fall back rather than pruning the log away", () => {
    // The dangerous failure is 0 or negative: it would make every line older
    // than `now` expire immediately and empty the log on the first tick.
    for (const raw of ["0", "-1", "abc", "NaN", "Infinity"]) {
      const r = resolveTtlMs(raw);
      expect(r.ms).toBe(MESSAGE_TTL_MS);
      expect(r.note).toContain("ignored");
    }
  });

  test("the resolved horizon is what keepLogLine actually enforces", () => {
    const { ms } = resolveTtlMs("2");
    const now = Date.parse("2026-09-05T00:00:00.000Z");
    const age = (h: number) => ({
      ts: new Date(now - h * 60 * 60 * 1000).toISOString(),
    });
    expect(keepLogLine(age(47), now, ms)).toBe(true);
    expect(keepLogLine(age(49), now, ms)).toBe(false);
  });
});

describe("resolveTtlMs diagnostic is log-safe", () => {
  test("the raw value is quoted and truncated, so it cannot forge diag.log lines", () => {
    // The note is written to diag.log as `${timestamp} ${line}` - a
    // newline-delimited file read back as records. An unquoted value carrying
    // a newline would inject an extra line that looks like a real record.
    const r = resolveTtlMs("x\nwhatsapp channel: forged line");
    expect(r.ms).toBe(MESSAGE_TTL_MS);
    expect(r.note).not.toContain("\n");
    expect(r.note).toContain("ignored");
  });

  test("a very long value cannot flood the log, and stays a parseable string", () => {
    const r = resolveTtlMs("9".repeat(5000));
    expect(r.note.length).toBeLessThan(200);
    // Truncating a quoted string would drop its closing quote and emit an
    // unterminated value into the records file the quoting exists to protect.
    const start = r.note.indexOf('"');
    const end = r.note.indexOf('"', start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(() => JSON.parse(r.note.slice(start, end + 1))).not.toThrow();
  });
});

describe("formatChatCounts", () => {
  const chat = (over: Partial<ChatCount> = {}): ChatCount => ({
    name: "Soham",
    unreplied: 1,
    mentionGated: false,
    ...over,
  });

  test("no message text appears anywhere - the whole point of the change", () => {
    const out = formatChatCounts([
      chat({ name: "Soham", unreplied: 3 }),
      chat({ name: "HUDINI", unreplied: 12, mentionGated: true }),
    ]);
    // The per-line shape assertion below is the real check, and it is a
    // stronger claim than "contains no colon" - which would also fail on a
    // chat legitimately named "Re: standup".
    for (const line of out.split("\n")) {
      expect(line).toMatch(/^\S.*\s\s\s[@ ]\d+$/);
    }
  });

  test("most unreplied first, then alphabetical", () => {
    const out = formatChatCounts([
      chat({ name: "Mum", unreplied: 1 }),
      chat({ name: "Zara", unreplied: 5 }),
      chat({ name: "Adi", unreplied: 5 }),
      chat({ name: "Soham", unreplied: 3 }),
    ]);
    expect(out.split("\n").map((l) => l.trim().split(/\s+/)[0])).toEqual([
      "Adi",
      "Zara",
      "Soham",
      "Mum",
    ]);
  });

  test("@ marks a mention-gated group and NOTHING else", () => {
    // Q2, owner 2026-09-05. An ungated group routes everything, so an @ there
    // would be true and useless.
    const out = formatChatCounts([
      chat({ name: "Gated", unreplied: 2, mentionGated: true }),
      chat({ name: "Ungated", unreplied: 2, mentionGated: false }),
      chat({ name: "ADm", unreplied: 2, mentionGated: false }),
    ]);
    const lines = out.split("\n");
    expect(lines.filter((l) => l.includes("@"))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith("Gated"))).toContain("@");
    expect(lines.find((l) => l.startsWith("Ungated"))).not.toContain("@");
  });

  test("a chat with nothing unreplied is omitted, not listed as 0", () => {
    const out = formatChatCounts([
      chat({ name: "Quiet", unreplied: 0 }),
      chat({ name: "Loud", unreplied: 4 }),
    ]);
    expect(out).not.toContain("Quiet");
    // Assert the ROW is gone, not that the digit 0 is absent - a count of 10,
    // or a chat named "Room 101", would fail that spuriously.
    expect(out).not.toMatch(/^\s*Quiet/m);
    expect(out.split("\n")).toHaveLength(1);
  });

  test("nothing waiting at all returns empty, so the caller can speak for itself", () => {
    expect(formatChatCounts([])).toBe("");
    expect(formatChatCounts([chat({ unreplied: 0 })])).toBe("");
  });

  test("names are column-aligned so the counts line up", () => {
    const out = formatChatCounts([
      chat({ name: "A", unreplied: 2 }),
      chat({ name: "LongerName", unreplied: 1 }),
    ]);
    const at = out.split("\n").map((l) => l.lastIndexOf(" ") + 1);
    expect(new Set(at).size).toBe(1);
  });
});

describe("chatDisplayName", () => {
  test("a group subject wins", () => {
    expect(
      chatDisplayName(
        [{ group_name: "WIL Group HUDINI", user: "Ravi", direction: "in" }],
        "120363427665348138@g.us",
      ),
    ).toBe("WIL Group HUDINI");
  });

  test("a real sender name is used when there is no group subject", () => {
    expect(
      chatDisplayName(
        [{ user: "Soham", direction: "in" }],
        "9198@s.whatsapp.net",
      ),
    ).toBe("Soham");
  });

  test("a NUMBER-SHAPED sender name is refused and masked instead", () => {
    // displaySenderName falls back to the jid's user part when the sender has
    // no WhatsApp profile name, so `user` can be a full phone number. Printing
    // it at session start would put a raw number on screen - the one thing
    // every tool here is supposed to prevent.
    const out = chatDisplayName(
      [{ user: "919876543210", direction: "in" }],
      "919876543210@s.whatsapp.net",
    );
    expect(out).not.toContain("919876543210");
    expect(out).toContain("•");
    expect(out).toContain("3210");
  });

  test("outbound-only entries never supply the name", () => {
    // "You" or the owner's own name must not become the chat's label.
    const out = chatDisplayName(
      [{ user: "You", direction: "out" }],
      "919876543210@s.whatsapp.net",
    );
    expect(out).not.toBe("You");
    expect(out).toContain("•");
  });

  test("a modern group id survives intact; nothing personal in it", () => {
    expect(chatDisplayName([], "120363427665348138@g.us")).toBe(
      "120363427665348138@g.us",
    );
  });

  test("a LEGACY group id has its creator's number masked", () => {
    const out = chatDisplayName([], "919876543210-1600000000@g.us");
    expect(out).not.toContain("919876543210");
    expect(out).toContain("1600000000");
  });
});

describe("chatDisplayName refuses a group_name that is really the chat id", () => {
  test("a legacy group jid stored as group_name does not print the creator's number", () => {
    // resolveGroupName falls back to the raw jid when the metadata lookup
    // times out, and lines persisted in that window carry it as group_name.
    const jid = "919876543210-1600000000@g.us";
    const out = chatDisplayName([{ group_name: jid, direction: "in" }], jid);
    expect(out).not.toContain("919876543210");
    expect(out).toContain("1600000000");
  });

  test("a real subject full of digits is KEPT, not mistaken for a number", () => {
    // looksLikeNumber matches any run of six digits, so "Sprint 2026-09-05"
    // would be rejected and the group silently listed under a member's name.
    // The only bad value resolveGroupName can produce is the chat id itself,
    // and that is excluded by identity, so no digit heuristic is needed here.
    const jid = "120363427665348138@g.us";
    for (const subject of ["Sprint 2026-09-05", "Batch 2019-2023"]) {
      expect(
        chatDisplayName([{ group_name: subject, direction: "in" }], jid),
      ).toBe(subject);
    }
  });

  test("the first USABLE subject wins, not merely the first present", () => {
    // The oldest line in the window can carry the raw jid from a timed-out
    // metadata lookup while a later line has the real subject.
    const jid = "120363427665348138@g.us";
    const out = chatDisplayName(
      [
        { group_name: jid, direction: "in" },
        { group_name: "WIL Group HUDINI", direction: "in" },
      ],
      jid,
    );
    expect(out).toBe("WIL Group HUDINI");
  });

  test("a real subject is still used", () => {
    expect(
      chatDisplayName(
        [{ group_name: "WIL Group HUDINI", direction: "in" }],
        "120363427665348138@g.us",
      ),
    ).toBe("WIL Group HUDINI");
  });
});

describe("formatChatCounts marker cannot be confused with an @ in a name", () => {
  test("an ungated chat whose NAME contains @ is not read as gated", () => {
    // Group subjects and pushNames are peer-controlled and safeName does not
    // strip "@". The marker is the character immediately before the count.
    const out = formatChatCounts([
      { name: "Standup @ 9", unreplied: 2, mentionGated: false },
      { name: "HUDINI", unreplied: 1, mentionGated: true },
    ]);
    const gatedRows = out
      .split("\n")
      .filter((l) => /@\d+$/.test(l))
      .map((l) => l.trim().split(/\s{2,}/)[0]);
    expect(gatedRows).toEqual(["HUDINI"]);
    // and the innocent name keeps its @ intact rather than being mangled
    expect(out).toContain("Standup @ 9");
  });
});

describe("chatDisplayName never labels a group with a member's name", () => {
  test("a group with no resolvable subject falls through to the anchor", () => {
    // Labelling it "Ravi" makes it indistinguishable from the DM with Ravi,
    // and the label would change between sessions as the window slides.
    const jid = "120363427665348138@g.us";
    expect(chatDisplayName([{ user: "Ravi", direction: "in" }], jid)).toBe(jid);
  });

  test("a legacy group with no subject masks the creator's number", () => {
    const out = chatDisplayName(
      [{ user: "Ravi", direction: "in" }],
      "919876543210-1600000000@g.us",
    );
    expect(out).not.toBe("Ravi");
    expect(out).not.toContain("919876543210");
  });

  test("a DM still uses the sender name", () => {
    expect(
      chatDisplayName(
        [{ user: "Soham", direction: "in" }],
        "9198@s.whatsapp.net",
      ),
    ).toBe("Soham");
  });
});
