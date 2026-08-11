/**
 * When the composer should ask for a key instead of accepting a message.
 *
 * Pure, because the answer depends only on which provider is selected and what
 * its snapshot says — and because getting it wrong in either direction is bad
 * in a way worth testing. Asking someone who already has a working agent is
 * worse than today; not asking someone with no key leaves them at a composer
 * that cannot send anything.
 *
 * @module components/chat/connectAgentGate
 */
import { type ServerProvider } from "@t3tools/contracts";

/** The built-in agent's driver. Anything else is a CLI we cannot hand a key to. */
const AGENT_DRIVER = "t3agent";

/**
 * Should the composer ask for a key?
 *
 * Only for the built-in agent, and only when its own snapshot reports the key
 * missing. A CLI provider that is unauthenticated needs `codex login`, not a
 * text box — pasting a key would do nothing.
 */
export function shouldAskForKey(provider: ServerProvider | null | undefined): boolean {
  if (!provider || provider.driver !== AGENT_DRIVER) {
    return false;
  }
  return provider.auth.status === "unauthenticated";
}

/**
 * Which provider a fresh install should land on.
 *
 * The built-in agent, but only when nothing else is configured. Someone who
 * already signed into Claude Code should never open the app to a key prompt —
 * the agent waits in the picker instead, which is where they would look for it.
 *
 * Returns null to mean "leave the existing default alone".
 */
export function preferredFirstRunProvider(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | null {
  const agent = providers.find((provider) => provider.driver === AGENT_DRIVER);
  if (agent === undefined) {
    return null;
  }
  const hasAnotherUsableProvider = providers.some(
    (provider) =>
      provider.driver !== AGENT_DRIVER &&
      provider.status !== "disabled" &&
      provider.auth.status !== "unauthenticated",
  );
  return hasAnotherUsableProvider ? null : agent;
}
