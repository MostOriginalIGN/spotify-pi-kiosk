import { describe, expect, it, vi } from "vitest";
import { SpotifyClient } from "./spotifyClient.js";

describe("SpotifyClient", () => {
  it("refreshes expired tokens and preserves the refresh token", async () => {
    const store = memoryStore({
      refresh_token: "refresh",
      access_token: "old",
      expires_at: 1
    });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (String(url).includes("accounts.spotify.com")) {
        return response({ access_token: "new", expires_in: 3600 });
      }
      if (String(url).includes("/me/player/devices")) {
        return response({ devices: [{ id: "pi-device", name: "raspotify (lofthub)" }] });
      }
      if (String(url).includes("/me/player/pause") && options.method === "PUT") {
        return response(null, 204);
      }
      return response(null, 204);
    });
    const client = new SpotifyClient({
      config: config(),
      tokenStore: store,
      fetchImpl
    });

    await client.pause();

    expect(store.value.access_token).toBe("new");
    expect(store.value.refresh_token).toBe("refresh");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/me/player/pause?device_id=pi-device"),
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("transfers playback before starting a track on the Pi", async () => {
    const calls = [];
    const store = memoryStore({
      refresh_token: "refresh",
      access_token: "access",
      expires_at: Date.now() + 100000
    });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/me/player/devices")) {
        return response({ devices: [{ id: "pi-device", name: "raspotify (lofthub)" }] });
      }
      return response(null, 204);
    });
    const client = new SpotifyClient({
      config: config(),
      tokenStore: store,
      fetchImpl
    });

    await client.play({ uri: "spotify:track:123" });

    expect(calls.some((call) => call.url.endsWith("/me/player"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/me/player/play?device_id=pi-device"))).toBe(true);
  });

  it("adds artist images to playback state for the backdrop", async () => {
    const store = memoryStore({
      refresh_token: "refresh",
      access_token: "access",
      expires_at: Date.now() + 100000
    });
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/me/player/devices")) {
        return response({ devices: [{ id: "pi-device", name: "raspotify (lofthub)" }] });
      }
      if (String(url).includes("device_id=pi-device")) {
        return response({
          item: {
            artists: [{ id: "artist-1", name: "Sinatra" }],
            album: { images: [{ url: "https://album.jpg", width: 640 }] }
          }
        });
      }
      if (String(url).includes("/artists/artist-1")) {
        return response({
          images: [{ url: "https://artist.jpg", width: 640 }]
        });
      }
      return response(null, 204);
    });
    const client = new SpotifyClient({
      config: config(),
      tokenStore: store,
      fetchImpl
    });

    const state = await client.getState();

    expect(state.item.artists[0].images[0].url).toBe("https://artist.jpg");
    expect(fetchImpl.mock.calls.some(([callUrl]) =>
      String(callUrl).includes("device_id=pi-device")
    )).toBe(true);
  });

  it("targets pause commands at the Pi device", async () => {
    const store = memoryStore({
      refresh_token: "refresh",
      access_token: "access",
      expires_at: Date.now() + 100000,
      deviceCachePath: ""
    });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (String(url).includes("/me/player/devices")) {
        return response({ devices: [{ id: "pi-device", name: "raspotify (lofthub)" }] });
      }
      if (String(url).includes("/me/player/pause") && options.method === "PUT") {
        return response(null, 204);
      }
      return response(null, 204);
    });
    const client = new SpotifyClient({
      config: config(),
      tokenStore: store,
      fetchImpl
    });

    await client.pause();

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/me/player/pause?device_id=pi-device"),
      expect.objectContaining({ method: "PUT" })
    );
  });
});

function config() {
  return {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1/callback",
    deviceName: "raspotify (lofthub)",
    deviceCachePath: "",
    connectTokenPath: ""
  };
}

function memoryStore(value) {
  return {
    value,
    async read() {
      return this.value;
    },
    async write(next) {
      this.value = next;
    }
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body ? JSON.stringify(body) : "")
  };
}
