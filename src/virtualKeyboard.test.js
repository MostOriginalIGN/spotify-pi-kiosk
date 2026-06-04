import { describe, expect, it } from "vitest";
import { applyVirtualKey } from "./virtualKeyboard.jsx";

describe("applyVirtualKey", () => {
  it("appends characters and respects shift", () => {
    expect(applyVirtualKey("ab", "c")).toBe("abc");
    expect(applyVirtualKey("ab", "c", { shifted: true })).toBe("abC");
  });

  it("handles space and backspace", () => {
    expect(applyVirtualKey("foo", "space")).toBe("foo ");
    expect(applyVirtualKey("foo ", "backspace")).toBe("foo");
  });
});
