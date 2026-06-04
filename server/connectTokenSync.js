import fs from "node:fs/promises";
import path from "node:path";

export function connectTokenSyncEnabled() {
  if (process.env.SPOTIFY_SYNC_CONNECT_TOKEN === "1") return true;
  if (process.env.SPOTIFY_SYNC_CONNECT_TOKEN === "0") return false;
  if (process.env.SPOTIFY_SYNC_RASPOTIFY === "1") return true;
  return false;
}

export function connectTokenEnvPath(configuredPath) {
  return (
    configuredPath ||
    process.env.SPOTIFY_CONNECT_TOKEN_PATH ||
    process.env.RASPOTIFY_TOKEN_ENV_PATH ||
    ""
  );
}

export async function syncConnectAccessToken(accessToken, envPath) {
  if (!accessToken || !connectTokenSyncEnabled() || !envPath) {
    return false;
  }

  const content = `LIBRESPOT_ACCESS_TOKEN=${accessToken}\n`;
  await fs.mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(envPath, content, { mode: 0o600 });
  return true;
}
