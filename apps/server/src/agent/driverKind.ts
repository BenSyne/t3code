/**
 * The driver kind for the built-in agent.
 *
 * This slug is permanent user data. It is the default instance id, and it
 * lands in persisted thread bindings, favourites, model preferences and
 * provider-status cache filenames. Renaming it later orphans all of that, so
 * it lives in one place and is never spelled inline.
 *
 * @module agent/driverKind
 */
import { ProviderDriverKind } from "@t3tools/contracts";

export const T3AGENT_DRIVER_KIND = ProviderDriverKind.make("t3agent");
