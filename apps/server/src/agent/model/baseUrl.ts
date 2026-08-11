/**
 * Where the agent is allowed to send a key.
 *
 * @module agent/model/baseUrl
 */

/** Hosts that cannot leave the machine, so cleartext is nobody else's business. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // `*.localhost` resolves to loopback per RFC 6761, and some local tooling uses it.
  return LOOPBACK_HOSTS.has(host) || host === "" || host.endsWith(".localhost");
}

/** Whether it is safe to send a credential to this address. */
export function isSafeBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname);
  }
  // Not a transport we can send a header over — `file:`, `data:` and friends.
  return false;
}

/** Why a base URL was refused, in words a user can act on. */
export const UNSAFE_BASE_URL_DETAIL =
  "That address would send your key over an unencrypted connection. Use https, or a local address like http://localhost:11434/v1.";

/** Narrow a configured base URL to one that may carry a credential. */
export function safeBaseUrlOrUndefined(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  return isSafeBaseUrl(trimmed) ? trimmed : undefined;
}
