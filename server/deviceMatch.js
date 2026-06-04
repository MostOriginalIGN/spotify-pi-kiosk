export function cleanDeviceName(name) {
  return String(name || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");
}

export function pickDevice(devices, targetName) {
  const list = (devices || []).filter((device) => device?.id);
  if (!list.length) return null;

  const target = cleanDeviceName(targetName);
  const targetLower = target.toLowerCase();

  const exact = list.find((device) => device.name === target);
  if (exact) return exact;

  const caseInsensitive = list.find(
    (device) => device.name?.toLowerCase() === targetLower
  );
  if (caseInsensitive) return caseInsensitive;

  const contains = list.find((device) =>
    device.name?.toLowerCase().includes(targetLower)
  );
  if (contains) return contains;

  const containedByTarget = list.find((device) =>
    targetLower.includes(device.name?.toLowerCase() || "")
  );
  if (containedByTarget) return containedByTarget;

  if (/raspotify/i.test(target)) {
    const raspotifyDevices = list.filter((device) =>
      /raspotify/i.test(device.name || "")
    );
    if (raspotifyDevices.length === 1) return raspotifyDevices[0];
    const speaker = raspotifyDevices.find((device) => device.type === "Speaker");
    if (speaker) return speaker;
    if (raspotifyDevices.length) return raspotifyDevices[0];
  }

  return null;
}

export function formatDeviceList(devices) {
  const list = devices || [];
  if (!list.length) return "none";
  return list.map((device) => device.name || "(unnamed)").join(", ");
}
