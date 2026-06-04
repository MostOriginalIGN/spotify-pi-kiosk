import { describe, expect, it } from "vitest";
import {
  collectionContextName,
  parseSpotifyUri,
  readableContextType
} from "./contextLabel.js";

describe("contextLabel", () => {
  it("parses spotify URIs", () => {
    expect(parseSpotifyUri("spotify:playlist:abc123")).toEqual({
      kind: "playlist",
      id: "abc123"
    });
  });

  it("normalizes playlist_v2 for display", () => {
    expect(readableContextType("playlist_v2")).toBe("playlist");
  });

  it("detects liked songs collections", () => {
    expect(
      collectionContextName("spotify:user:demo:collection:tracks")
    ).toBe("Liked Songs");
  });
});
