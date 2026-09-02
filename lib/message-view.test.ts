import { describe, expect, test } from "bun:test";
import {
  awaitingReply,
  keepLogLine,
  NOT_ADDRESSED,
  recentBothSides,
  recentWindow,
  renderLogEntry,
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

describe("keepLogLine", () => {
  test("ONE horizon: an unanswered inbound lives the same 7 days as everything else", () => {
    // Regression for #20. An unanswered inbound used to die at 24h, so the
    // message you had not got to yet was the first thing to vanish.
    expect(keepLogLine({ ts: hoursAgo(25), direction: "in" }, now)).toBe(true);
    expect(keepLogLine({ ts: hoursAgo(6 * 24), direction: "in" }, now)).toBe(
      true,
    );
    expect(keepLogLine({ ts: hoursAgo(8 * 24), direction: "in" }, now)).toBe(
      false,
    );
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
      keepLogLine({ ts: eightDays, direction: "in", routed: false }, now),
    ).toBe(false);
    expect(
      keepLogLine({ ts: eightDays, direction: "out", by: "owner" }, now),
    ).toBe(false);
  });
  test("a caller-supplied ttl wins over the default (WHATSAPP_MESSAGE_TTL_DAYS)", () => {
    const day = 24 * 60 * 60 * 1000;
    const tenDays = hoursAgo(10 * 24);
    expect(keepLogLine({ ts: tenDays, direction: "in" }, now)).toBe(false);
    expect(keepLogLine({ ts: tenDays, direction: "in" }, now, 14 * day)).toBe(
      true,
    );
    expect(
      keepLogLine({ ts: hoursAgo(2), direction: "in" }, now, 1 * day),
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
