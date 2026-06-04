import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, spotifyScopes } from "./config.js";
import { EventBus } from "./eventBus.js";
import { SpotifyClient, SpotifyError, spotifyErrorMessage } from "./spotifyClient.js";
import { TokenStore } from "./tokenStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const events = new EventBus();
const tokenStore = new TokenStore(config.tokenStorePath);
const spotify = new SpotifyClient({ config: config.spotify, tokenStore });
const authStates = new Set();

app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: spotify.configured });
});

app.get("/api/config", async (_req, res, next) => {
  try {
    res.json({
      configured: spotify.configured,
      authenticated: await spotify.isAuthenticated(),
      deviceName: config.spotify.deviceName,
      deviceHint: config.deviceHint,
      envFile: path.join(process.cwd(), ".env")
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/login", (_req, res) => {
  if (!spotify.configured) {
    res.status(400).send("Spotify client credentials are not configured.");
    return;
  }
  const state = crypto.randomBytes(16).toString("hex");
  authStates.add(state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.spotify.clientId,
    scope: spotifyScopes.join(" "),
    redirect_uri: config.spotify.redirectUri,
    state
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/api/auth/callback", async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) throw new Error(String(error));
    if (!code || !state || !authStates.has(String(state))) {
      res.status(400).send("Invalid Spotify authentication callback.");
      return;
    }
    authStates.delete(String(state));
    await spotify.exchangeCode(String(code));
    events.emit("auth", { authenticated: true });
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (_req, res, next) => {
  try {
    await tokenStore.clear();
    events.emit("auth", { authenticated: false });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/player/state", route(async () => spotify.getState()));
app.get("/api/player/queue", route(async () => {
  try {
    return await spotify.getQueue();
  } catch (error) {
    if (error instanceof SpotifyError && (error.status === 404 || error.status === 403)) {
      return { queue: [] };
    }
    throw error;
  }
}));
app.put("/api/player/transfer-to-device", route(async () => spotify.transferToDevice()));
app.put("/api/player/transfer-to-pi", route(async () => spotify.transferToDevice()));
app.put("/api/player/play", route(async (req) => spotify.play(req.body || {}), true));
app.put("/api/player/pause", route(async () => spotify.pause(), true));
app.post("/api/player/next", route(async () => spotify.next(), true));
app.post("/api/player/previous", route(async () => spotify.previous(), true));
app.post("/api/player/seek", route(async (req) => spotify.seek(safeInt(req.body.positionMs)), true));
app.post("/api/player/shuffle", route(async (req) => spotify.shuffle(req.body.state), true));
app.post("/api/player/repeat", route(async (req) => spotify.repeat(req.body.state), true));
app.post("/api/player/volume", route(async (req) => spotify.volume(safeVolume(req.body.percent)), true));

app.put("/api/tracks/:id/saved", route(async (req) => spotify.saveTrack(req.params.id)));
app.delete("/api/tracks/:id/saved", route(async (req) => spotify.removeTrack(req.params.id)));

app.get("/api/browse/home", route(async () => spotify.browseHome()));
app.get("/api/search", route(async (req) => spotify.search(String(req.query.q || ""), String(req.query.type || "track,album,playlist,artist"))));
app.get("/api/playlists/:id", route(async (req) => spotify.playlist(req.params.id)));
app.get("/api/albums/:id", route(async (req) => spotify.album(req.params.id)));
app.get("/api/artists/:id", route(async (req) => spotify.artistDetail(req.params.id)));

async function handleConnectDeviceEvent(req, res, next) {
  if (!isLocalRequest(req)) {
    res.status(403).json({ error: "Connect device events are only accepted locally." });
    return;
  }
  try {
    const body = req.body || {};
    if (body.PLAYER_EVENT) {
      console.log(`connect-device event: ${body.PLAYER_EVENT}`);
    }
    events.emit("connect-device", body);
    events.emit("raspotify", body);
    if (shouldSyncPlayerState(body.PLAYER_EVENT)) {
      try {
        const state = await spotify.getState();
        events.emit("player-state", state);
      } catch (error) {
        console.error("connect-device player-state sync failed:", error.message);
      }
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

app.post("/api/connect-device/event", handleConnectDeviceEvent);
app.post("/api/raspotify/event", handleConnectDeviceEvent);

function shouldSyncPlayerState(event) {
  return (
    event === "changed" ||
    event === "change" ||
    event === "track_changed" ||
    event === "playing" ||
    event === "paused" ||
    event === "stopped" ||
    event === "start" ||
    event === "stop" ||
    event === "started" ||
    event === "preloading"
  );
}

app.get("/api/events", (req, res) => {
  const disconnect = events.connect(res);
  req.on("close", disconnect);
});

if (process.env.NODE_ENV !== "development") {
  const dist = path.join(__dirname, "..", "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error, _req, res, _next) => {
  const status = error instanceof SpotifyError ? error.status || 500 : 500;
  console.error(error);
  res.status(status).json({
    error: spotifyErrorMessage(error),
    details: process.env.NODE_ENV === "development" ? error.body || null : null
  });
});

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

app.listen(config.port, config.host, () => {
  console.log(`Spotify kiosk listening on http://${config.host}:${config.port}`);
  spotify.isAuthenticated().then((authenticated) => {
    if (authenticated) return spotify.syncConnectToken();
    return false;
  }).catch(() => {});
});

function route(handler, emitPlayer = false) {
  return async (req, res, next) => {
    try {
      const data = await handler(req);
      if (emitPlayer) events.emit("player-command", {});
      res.json(data ?? { ok: true });
    } catch (error) {
      next(error);
    }
  };
}

function safeInt(value) {
  const int = Number(value);
  if (!Number.isFinite(int) || int < 0) return 0;
  return Math.round(int);
}

function safeVolume(value) {
  const int = safeInt(value);
  return Math.max(0, Math.min(100, int));
}
