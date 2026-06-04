import { describe, expect, it } from "vitest";
import { cleanDeviceName, pickDevice } from "./deviceMatch.js";

describe("pickDevice", () => {
  it("matches exact and case-insensitive names", () => {
    const devices = [
      { id: "1", name: "Raspotify (lofthub)", type: "Speaker" },
      { id: "2", name: "Web Player", type: "Computer" }
    ];
    expect(pickDevice(devices, "raspotify (lofthub)")).toEqual(devices[0]);
  });

  it("falls back to the only raspotify speaker", () => {
    const devices = [
      { id: "1", name: "raspotify (bedroom)", type: "Speaker" },
      { id: "2", name: "MacBook Pro", type: "Computer" }
    ];
    expect(pickDevice(devices, "raspotify (lofthub)")).toEqual(devices[0]);
  });

  it("ignores devices without ids", () => {
    expect(
      pickDevice([{ id: null, name: "raspotify (lofthub)" }], "raspotify (lofthub)")
    ).toBeNull();
  });
});

describe("cleanDeviceName", () => {
  it("trims quotes and whitespace", () => {
    expect(cleanDeviceName('"raspotify (lofthub)"')).toBe("raspotify (lofthub)");
  });
});
