/** A world someone was sent to from a Join button on the site. */
export type Join = { address: string; name: string };

const HOST_PORT = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

/**
 * Reads `anything://join?address=host:port&name=...`. Only a host and a port
 * get through: the address goes straight to the game's --server flag, so
 * anything else in a link from the web is refused.
 */
export function parseJoin(link: string): Join | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "anything:") return null;
  // anything://join?... parses with "join" as the host; anything:join?... as the path.
  const what = (url.host || url.pathname).replace(/^\/+|\/+$/g, "");
  if (what !== "join") return null;
  const address = (url.searchParams.get("address") ?? "").trim();
  if (!HOST_PORT.test(address)) return null;
  const port = address.split(":")[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  const name = (url.searchParams.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { address, name: name || address };
}
