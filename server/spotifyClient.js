import fs from "node:fs/promises";
import path from "node:path";
import {
  collectionContextName,
  normalizeContextType,
  parseSpotifyUri,
  readableContextType
} from "./contextLabel.js";
import { formatDeviceList, pickDevice } from "./deviceMatch.js";
import { syncConnectAccessToken } from "./connectTokenSync.js";

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com/api/token";
const DEVICE_LOOKUP_ATTEMPTS = 5;
const DEVICE_LOOKUP_DELAY_MS = 400;

export class SpotifyError extends Error {
  constructor(message, response, body) {
    super(message);
    this.name = "SpotifyError";
    this.status = response?.status;
    this.body = body;
  }
}

export function spotifyErrorMessage(error) {
  if (!(error instanceof SpotifyError)) {
    return error?.message || "Unexpected error";
  }
  const spotifyMessage = error.body?.error?.message;
  if (spotifyMessage) {
    if (error.status === 429) return `Spotify rate limit: ${spotifyMessage}`;
    return spotifyMessage;
  }
  return error.message || "Spotify API request failed";
}

export class SpotifyClient {
  constructor({ config, tokenStore, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.tokenStore = tokenStore;
    this.fetch = fetchImpl;
    this.contextLabelCache = new Map();
    this.artistImageCache = new Map();
    this.trackSavedCache = new Map();
  }

  get configured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  async isAuthenticated() {
    const tokens = await this.tokenStore.read();
    return Boolean(tokens?.refresh_token);
  }

  async exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri
    });
    const tokens = await this.tokenRequest(body);
    await this.tokenStore.write(this.normalizeTokens(tokens));
    await this.syncConnectToken();
    return tokens;
  }

  async refresh() {
    const current = await this.tokenStore.read();
    if (!current?.refresh_token) {
      throw new SpotifyError("Spotify account is not authenticated");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token
    });
    const next = await this.tokenRequest(body);
    const tokens = this.normalizeTokens({
      ...next,
      refresh_token: next.refresh_token || current.refresh_token
    });
    await this.tokenStore.write(tokens);
    return tokens;
  }

  async tokenRequest(body) {
    if (!this.configured) {
      throw new SpotifyError("Spotify client credentials are not configured");
    }
    const response = await this.fetch(SPOTIFY_ACCOUNTS, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.config.clientId}:${this.config.clientSecret}`
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const json = await readJson(response);
    if (!response.ok) {
      throw new SpotifyError("Spotify token request failed", response, json);
    }
    return json;
  }

  normalizeTokens(tokens) {
    return {
      ...tokens,
      expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000 - 60000
    };
  }

  async accessToken() {
    const tokens = await this.tokenStore.read();
    if (!tokens?.refresh_token) {
      throw new SpotifyError("Spotify account is not authenticated");
    }
    if (!tokens.access_token || Date.now() > Number(tokens.expires_at || 0)) {
      return (await this.refresh()).access_token;
    }
    return tokens.access_token;
  }

  async request(path, options = {}, retry = true) {
    const token = await this.accessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    };
    const response = await this.fetch(`${SPOTIFY_API}${path}`, {
      ...options,
      headers
    });
    if (response.status === 401 && retry) {
      await this.refresh();
      return this.request(path, options, false);
    }
    if (response.status === 204) return null;
    const json = await readJson(response);
    if (!response.ok) {
      throw new SpotifyError("Spotify API request failed", response, json);
    }
    return json;
  }

  async getQueue() {
    return this.request("/me/player/queue");
  }

  async getState() {
    let deviceId = await this.resolveDeviceId();
    let state = await this.requestPlayerState(deviceId);
    if (state === null) {
      const device = await this.getTargetDevice({ allowWake: false });
      const nextId = device?.id || null;
      if (nextId && nextId !== deviceId) {
        deviceId = nextId;
        state = await this.requestPlayerState(deviceId);
      }
    }
    const labeled = await this.withContextLabel(state);
    const withArt = await this.withArtistImages(labeled);
    return this.withTrackSaved(withArt);
  }

  async requestPlayerState(deviceId) {
    const params = new URLSearchParams({
      additional_types: "track,episode"
    });
    if (deviceId) params.set("device_id", deviceId);
    return this.request(`/me/player?${params}`);
  }

  async resolveDeviceId() {
    const cached = await this.readDeviceCache();
    if (cached?.id) return cached.id;
    const device = await this.getTargetDevice({ allowWake: false });
    return device?.id || null;
  }

  async playerRequest(path, options = {}) {
    let deviceId = await this.resolveDeviceId();
    if (!deviceId) {
      const device = await this.getTargetDevice({ allowWake: true });
      deviceId = device?.id || null;
    }
    if (!deviceId) {
      throw new SpotifyError(
        `Spotify device not found: ${this.config.deviceName}`
      );
    }
    const params = new URLSearchParams({ device_id: deviceId });
    const separator = path.includes("?") ? "&" : "?";
    return this.request(`${path}${separator}${params}`, options);
  }

  async withTrackSaved(state) {
    const id = state?.item?.id;
    if (!id || state.item.type === "episode") return state;

    let saved = this.trackSavedCache.get(id);
    if (saved === undefined) {
      try {
        const result = await this.request(
          `/me/tracks/contains?ids=${encodeURIComponent(id)}`
        );
        saved = Boolean(result?.[0]);
        this.trackSavedCache.set(id, saved);
      } catch (_error) {
        return state;
      }
    }

    return { ...state, item: { ...state.item, saved } };
  }

  async isTrackSaved(id) {
    if (this.trackSavedCache.has(id)) {
      return this.trackSavedCache.get(id);
    }
    const result = await this.request(
      `/me/tracks/contains?ids=${encodeURIComponent(id)}`
    );
    const saved = Boolean(result?.[0]);
    this.trackSavedCache.set(id, saved);
    return saved;
  }

  saveTrack(id) {
    this.trackSavedCache.set(id, true);
    return this.request(`/me/tracks?ids=${encodeURIComponent(id)}`, {
      method: "PUT"
    });
  }

  removeTrack(id) {
    this.trackSavedCache.set(id, false);
    return this.request(`/me/tracks?ids=${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  }

  async withArtistImages(state) {
    const artistId = state?.item?.artists?.[0]?.id;
    if (!artistId) return state;

    let images = this.artistImageCache.get(artistId);
    if (!images) {
      try {
        const artist = await this.artist(artistId);
        images = artist?.images || null;
        if (images?.length) this.artistImageCache.set(artistId, images);
      } catch (_error) {
        images = null;
      }
    }

    if (!images?.length) return state;
    const artists = state.item.artists.map((artist, index) =>
      index === 0 ? { ...artist, images } : artist
    );
    return { ...state, item: { ...state.item, artists } };
  }

  async withContextLabel(state) {
    if (!state?.context?.uri) return state;
    const label = await this.resolveContextLabel(state.context);
    return label ? { ...state, context_label: label } : state;
  }

  async resolveContextLabel(context) {
    const uri = context?.uri;
    if (!uri) return null;
    if (this.contextLabelCache.has(uri)) {
      return this.contextLabelCache.get(uri);
    }

    const type = readableContextType(context.type);
    let name = collectionContextName(uri);

    if (!name) {
      const resource = parseSpotifyUri(uri);
      const kind = normalizeContextType(resource?.kind || context.type);
      try {
        if (kind === "playlist" && resource?.id) {
          name = (await this.playlist(resource.id))?.name;
        } else if (kind === "album" && resource?.id) {
          name = (await this.album(resource.id))?.name;
        } else if (kind === "artist" && resource?.id) {
          name = (await this.artist(resource.id))?.name;
        }
      } catch (_error) {
        name = null;
      }
    }

    if (!name) return null;
    const label = { type, name };
    this.contextLabelCache.set(uri, label);
    return label;
  }

  async getDevices() {
    return this.request("/me/player/devices");
  }

  async getTargetDevice({ allowWake = true } = {}) {
    for (let attempt = 0; attempt < DEVICE_LOOKUP_ATTEMPTS; attempt += 1) {
      const data = await this.getDevices();
      const device = pickDevice(data?.devices, this.config.deviceName);
      if (device?.id) {
        await this.saveDeviceCache(device);
        return device;
      }
      if (attempt < DEVICE_LOOKUP_ATTEMPTS - 1) {
        await sleep(DEVICE_LOOKUP_DELAY_MS);
      }
    }

    const state = await this.getState();
    const fromState = pickDevice(
      state?.device ? [state.device] : [],
      this.config.deviceName
    );
    if (fromState?.id) {
      await this.saveDeviceCache(fromState);
      return fromState;
    }

    const cached = await this.readDeviceCache();
    if (cached?.id) {
      return cached;
    }

    if (allowWake) {
      const woke = await this.syncConnectToken();
      if (woke) {
        return this.getTargetDevice({ allowWake: false });
      }
    }

    return null;
  }

  async transferToDevice({ play = false } = {}) {
    let device = await this.getTargetDevice();
    if (!device?.id) {
      const listed = (await this.getDevices())?.devices || [];
      throw new SpotifyError(
        `Spotify device not found: ${this.config.deviceName}. Available: ${formatDeviceList(listed)}`
      );
    }

    try {
      await this.request("/me/player", {
        method: "PUT",
        body: JSON.stringify({ device_ids: [device.id], play })
      });
      await this.saveDeviceCache(device);
      return device;
    } catch (error) {
      if (!(error instanceof SpotifyError) || error.status !== 404) {
        throw error;
      }
      device = await this.getTargetDevice({ allowWake: true });
      if (!device?.id) throw error;
      await this.request("/me/player", {
        method: "PUT",
        body: JSON.stringify({ device_ids: [device.id], play })
      });
      await this.saveDeviceCache(device);
      return device;
    }
  }

  async syncConnectToken() {
    try {
      const token = await this.accessToken();
      return syncConnectAccessToken(token, this.config.connectTokenPath);
    } catch (_error) {
      return false;
    }
  }

  async readDeviceCache() {
    if (!this.config.deviceCachePath) return null;
    try {
      const body = await fs.readFile(this.config.deviceCachePath, "utf8");
      const cached = JSON.parse(body);
      return cached?.id ? cached : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveDeviceCache(device) {
    if (!this.config.deviceCachePath || !device?.id) return;
    await fs.mkdir(path.dirname(this.config.deviceCachePath), {
      recursive: true,
      mode: 0o700
    });
    await fs.writeFile(
      this.config.deviceCachePath,
      JSON.stringify(
        { id: device.id, name: device.name, saved_at: Date.now() },
        null,
        2
      ),
      { mode: 0o600 }
    );
  }

  async play({ uri, contextUri, offset, positionMs } = {}) {
    const device = await this.transferToDevice({ play: false });
    const payload = {};
    if (contextUri) payload.context_uri = contextUri;
    if (uri) payload.uris = [uri];
    if (offset) payload.offset = offset;
    if (Number.isFinite(positionMs)) payload.position_ms = positionMs;
    await this.request(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    return device;
  }

  pause() {
    return this.playerRequest("/me/player/pause", { method: "PUT" });
  }

  next() {
    return this.playerRequest("/me/player/next", { method: "POST" });
  }

  previous() {
    return this.playerRequest("/me/player/previous", { method: "POST" });
  }

  seek(positionMs) {
    return this.playerRequest(`/me/player/seek?position_ms=${positionMs}`, {
      method: "PUT"
    });
  }

  shuffle(state) {
    return this.playerRequest(`/me/player/shuffle?state=${Boolean(state)}`, {
      method: "PUT"
    });
  }

  repeat(state) {
    return this.playerRequest(
      `/me/player/repeat?state=${encodeURIComponent(state)}`,
      { method: "PUT" }
    );
  }

  volume(percent) {
    return this.playerRequest(`/me/player/volume?volume_percent=${percent}`, {
      method: "PUT"
    });
  }

  async browseHome() {
    const [playlists, recent, topTracks, topArtists] = await Promise.all([
      this.request("/me/playlists?limit=20"),
      this.request("/me/player/recently-played?limit=12"),
      this.request("/me/top/tracks?limit=12&time_range=medium_term"),
      this.request("/me/top/artists?limit=12&time_range=medium_term")
    ]);
    return { playlists, recent, topTracks, topArtists };
  }

  search(query, type = "track,album,playlist,artist", limit = 12) {
    const params = new URLSearchParams({ q: query, type, limit: String(limit) });
    return this.request(`/search?${params}`);
  }

  playlist(id) {
    return this.request(`/playlists/${encodeURIComponent(id)}`);
  }

  album(id) {
    return this.request(`/albums/${encodeURIComponent(id)}`);
  }

  artist(id) {
    return this.request(`/artists/${encodeURIComponent(id)}`);
  }

  async artistDetail(id) {
    const market = encodeURIComponent(this.config.market || "US");
    const artistId = encodeURIComponent(id);
    const [artist, albums, topTracks] = await Promise.all([
      this.artist(id),
      this.request(
        `/artists/${artistId}/albums?include_groups=album,single&limit=24&market=${market}`
      ),
      this.request(`/artists/${artistId}/top-tracks?market=${market}`)
    ]);
    return {
      ...artist,
      albums: dedupeById(albums?.items || []),
      topTracks: topTracks?.tracks || []
    };
  }
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
