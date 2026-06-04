export function readDemoMode(search = "") {
  const params = new URLSearchParams(search);
  if (!params.has("demo")) return null;
  return params.get("demo") === "now" ? "now" : "library";
}
