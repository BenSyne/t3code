/**
 * Where the agent is allowed to send a key.
 *
 * A custom base URL is a genuine feature — it is how anyone points the agent at
 * Ollama, LM Studio or vLLM — but it is also the one setting that decides where
 * the credential goes. Every request the agent makes carries the key in a
 * header, so an `http://` address off this machine puts it on the wire in
 * cleartext for anything between here and there to read.
 *
 * The rule: encrypted, or not leaving the machine. `https` anywhere, `http`
 * only on loopback. That keeps every local-server setup working — they are all
 * localhost — while refusing the shapes that leak.
 *
 * Checked where the value is accepted *and* where it is read back, because
 * settings are a file a person can edit, and a check that only runs on the way
 * in is not a check.
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

/**
 * Whether it is safe to send a credential to this address.
 *
 * Anything unparseable is refused rather than guessed at: a base URL we cannot
 * read is one we cannot reason about.
 */
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

/**
 * Narrow a configured base URL to one that may carry a credential.
 *
 * Returns `undefined` for an empty or unsafe value, which every caller already
 * treats as "no custom URL" — so a bad one falls back to the default rather
 * than failing the provider outright.
 */
export function safeBaseUrlOrUndefined(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  return isSafeBaseUrl(trimmed) ? trimmed : undefined;
}
