import dotenv from "dotenv";
import os from "node:os";
import { cleanDeviceName } from "./deviceMatch.js";

dotenv.config();

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 4928),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://127.0.0.1:4928",
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    redirectUri:
      process.env.SPOTIFY_REDIRECT_URI ||
      "http://127.0.0.1:4928/api/auth/callback",
    deviceName: cleanDeviceName(
      process.env.SPOTIFY_DEVICE_NAME || os.hostname()
    ),
    market: process.env.SPOTIFY_MARKET || "US",
    deviceCachePath:
      process.env.SPOTIFY_DEVICE_CACHE_PATH || "./data/device-cache.json",
    connectTokenPath:
      process.env.SPOTIFY_CONNECT_TOKEN_PATH ||
      process.env.RASPOTIFY_TOKEN_ENV_PATH ||
      ""
  },
  tokenStorePath: process.env.TOKEN_STORE_PATH || "./data/tokens.json",
  deviceHint: {
    enabled: process.env.DEVICE_HINT_ENABLED !== "0",
    intervalMs: Math.max(
      60000,
      Number(process.env.DEVICE_HINT_INTERVAL_MS || 300000)
    )
  }
};

export const spotifyScopes = [
  "streaming",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-library-modify",
  "user-read-recently-played",
  "user-top-read"
];
