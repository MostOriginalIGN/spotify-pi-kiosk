export function parseSpotifyUri(uri) {
  const match = String(uri || "").match(/^spotify:([^:]+):(.+)$/);
  if (!match) return null;
  return { kind: match[1], id: match[2] };
}

export function normalizeContextType(type) {
  if (type === "playlist_v2") return "playlist";
  return type || null;
}

export function readableContextType(type) {
  const normalized = normalizeContextType(type);
  if (normalized === "playlist") return "playlist";
  if (normalized === "album") return "album";
  if (normalized === "artist") return "artist";
  if (normalized === "show") return "podcast";
  if (normalized === "collection") return "your library";
  return normalized || "Spotify";
}

export function collectionContextName(uri) {
  if (!String(uri || "").includes(":collection")) return null;
  return "Liked Songs";
}
