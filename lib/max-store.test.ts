import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_STORE, parseMaxStore } from "./max-store";

describe("parseMaxStore", () => {
  test("unset falls back to the default", () => {
    expect(parseMaxStore(undefined)).toBe(DEFAULT_MAX_STORE);
  });

  test("blank falls back to the default", () => {
    expect(parseMaxStore("")).toBe(DEFAULT_MAX_STORE);
    expect(parseMaxStore("   ")).toBe(DEFAULT_MAX_STORE);
  });

  test("a valid positive integer is used as-is", () => {
    expect(parseMaxStore("5000")).toBe(5000);
    expect(parseMaxStore("1")).toBe(1);
  });

  test("non-numeric falls back to the default", () => {
    expect(parseMaxStore("abc")).toBe(DEFAULT_MAX_STORE);
  });

  test("negative falls back to the default", () => {
    expect(parseMaxStore("-5")).toBe(DEFAULT_MAX_STORE);
  });

  test("zero falls back to the default", () => {
    expect(parseMaxStore("0")).toBe(DEFAULT_MAX_STORE);
  });

  test("fractional falls back to the default", () => {
    expect(parseMaxStore("100.5")).toBe(DEFAULT_MAX_STORE);
  });

  test("Infinity falls back to the default", () => {
    expect(parseMaxStore("Infinity")).toBe(DEFAULT_MAX_STORE);
    expect(parseMaxStore("-Infinity")).toBe(DEFAULT_MAX_STORE);
  });
});
