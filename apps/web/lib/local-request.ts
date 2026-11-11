/**
 * Job routes can start processes, so accept JSON requests only from this machine's web UI.
 * A browser still sends Origin for same-origin POSTs; command-line clients omit it.
 */
export function isLocalRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function isJsonRequest(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return type.toLowerCase().startsWith("application/json");
}
