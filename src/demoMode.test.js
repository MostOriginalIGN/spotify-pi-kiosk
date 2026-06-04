import { describe, expect, it } from "vitest";
import { readDemoMode } from "./demoMode.js";

describe("readDemoMode", () => {
  it("enables library demo for ?demo", () => {
    expect(readDemoMode("?demo")).toBe("library");
  });

  it("enables now playing demo for ?demo=now", () => {
    expect(readDemoMode("?demo=now")).toBe("now");
  });

  it("returns null when demo param is absent", () => {
    expect(readDemoMode("")).toBeNull();
  });
});
