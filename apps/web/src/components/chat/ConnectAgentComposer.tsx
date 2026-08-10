/**
 * The composer, before there is a key to talk to.
 *
 * Setting the agent up used to mean a trip through Settings, a new provider
 * instance, and knowing the thing it wants is an environment variable called
 * `OPENROUTER_API_KEY`. So the ask moved to the one place the user is already
 * looking: the box they would type into.
 *
 * It *looks* like the composer and is deliberately not the composer. A real
 * composer persists drafts, and a key pasted into one would be written to the
 * drafts store and outlive the moment by months. This keeps its value in local
 * component state, masks it, and clears it the instant it is accepted — it
 * never touches `composerDraftStore`.
 *
 * One provider, on purpose. The agent also runs against Anthropic, Cerebras and
 * any OpenAI-compatible server, but every option offered here is a decision
 * asked of someone who has not sent a message yet. Those live in Settings,
 * which is where a person who already knows they want them will look.
 *
 * @module components/chat/ConnectAgentComposer
 */
import { type ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useState, type KeyboardEvent } from "react";
import { KeyRoundIcon, Loader2Icon } from "lucide-react";

import { cn } from "~/lib/utils";

/** Where to send someone who does not have a key yet. */
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

export type ConnectAttempt =
  | { readonly _tag: "Ok"; readonly modelCount: number }
  | { readonly _tag: "Rejected"; readonly detail: string }
  | { readonly _tag: "Unreachable"; readonly detail: string };

export interface ConnectAgentComposerProps {
  readonly instanceId: ProviderInstanceId;
  /** Verifies and stores. Resolves with the outcome; never throws for a bad key. */
  readonly onConnect: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly backend: string;
    readonly secret?: string;
  }) => Promise<ConnectAttempt>;
}

/**
 * Decide what to tell the user after an attempt.
 *
 * Pure, so the wording is testable without a server. `Ok` returns null because
 * success is shown by the composer turning back into a composer — a message
 * saying "connected" on a screen that has visibly changed is noise.
 */
export function messageForAttempt(attempt: ConnectAttempt): string | null {
  return attempt._tag === "Ok" ? null : attempt.detail;
}

export function ConnectAgentComposer({ instanceId, onConnect }: ConnectAgentComposerProps) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !busy && secret.trim() !== "";

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await onConnect({
        instanceId,
        backend: "openrouter",
        secret: secret.trim(),
      });
      setError(messageForAttempt(attempt));
      if (attempt._tag === "Ok") {
        // Nothing keeps the key around after it has been handed over.
        setSecret("");
      }
    } catch (cause) {
      // Without this the button looked broken: a rejected request was an
      // unhandled rejection, so the press produced no error, no success and
      // nothing in any log — the one failure mode that tells nobody anything.
      // Whatever went wrong, say so and include the reason.
      setError(
        `Could not reach the server to check that key. ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  }, [canSubmit, instanceId, onConnect, secret]);

  return (
    // A div, not a form. This renders inside the composer, which is itself a
    // form, and a nested form is dropped by the browser — the submit handler
    // never fires and the press silently submits the outer one instead. Enter
    // is wired on the input to keep the behaviour a text field should have.
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "flex items-center gap-2 rounded-2xl border bg-card px-3 py-2.5 transition-colors",
          error ? "border-destructive/50" : "border-border focus-within:border-ring",
        )}
      >
        <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />

        <input
          // Masked and excluded from anything that remembers input. A key must
          // not survive in a password manager entry, a form restore, or a draft.
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          name="t3-agent-key"
          aria-label="OpenRouter API key"
          placeholder="Paste your OpenRouter key to get started"
          value={secret}
          disabled={busy}
          onChange={(event) => setSecret(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />

        {/* Says the word rather than showing an arrow. An arrow beside a text
            field reads as "send", and sending is the one thing this cannot do
            yet — the label is what removes the doubt. */}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3 font-medium text-primary-foreground text-xs transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              Checking
            </>
          ) : (
            "Connect"
          )}
        </button>
      </div>

      {error === null ? null : (
        <p role="alert" className="px-1 text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-muted-foreground text-xs">
        <a
          href={OPENROUTER_KEYS_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Get a key →
        </a>
        <span className="ms-auto">Or pick another agent below.</span>
      </div>
    </div>
  );
}
