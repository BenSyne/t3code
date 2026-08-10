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
 * @module components/chat/ConnectAgentComposer
 */
import { type ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useState, type FormEvent } from "react";
import { ArrowRightIcon, KeyRoundIcon, Loader2Icon, ServerIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/** Where to send someone who does not have a key yet. */
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

/** Ollama's default, which is what most people running something local have. */
export const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";

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
    readonly baseUrl?: string;
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
  const [localUrl, setLocalUrl] = useState(DEFAULT_LOCAL_URL);
  const [useLocal, setUseLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = useLocal ? localUrl : secret;
  const canSubmit = !busy && value.trim() !== "";

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      setBusy(true);
      setError(null);
      try {
        const attempt = await onConnect(
          useLocal
            ? { instanceId, backend: "openai-compat", baseUrl: localUrl.trim() }
            : { instanceId, backend: "openrouter", secret: secret.trim() },
        );
        setError(messageForAttempt(attempt));
        if (attempt._tag === "Ok") {
          // Nothing keeps the key around after it has been handed over.
          setSecret("");
        }
      } finally {
        setBusy(false);
      }
    },
    [canSubmit, instanceId, localUrl, onConnect, secret, useLocal],
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div
        className={cn(
          "flex items-center gap-2 rounded-2xl border bg-card px-3 py-2.5 transition-colors",
          error ? "border-destructive/50" : "border-border focus-within:border-ring",
        )}
      >
        {useLocal ? (
          <ServerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}

        <input
          // Masked and excluded from anything that remembers input. A key must
          // not survive in a password manager entry, a form restore, or a draft.
          type={useLocal ? "url" : "password"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          name={useLocal ? "t3-agent-local-url" : "t3-agent-key"}
          aria-label={useLocal ? "Local server URL" : "OpenRouter API key"}
          placeholder={useLocal ? DEFAULT_LOCAL_URL : "Paste your OpenRouter key to get started"}
          value={value}
          disabled={busy}
          onChange={(event) =>
            useLocal ? setLocalUrl(event.target.value) : setSecret(event.target.value)
          }
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />

        <button
          type="submit"
          disabled={!canSubmit}
          aria-label="Connect"
          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <ArrowRightIcon className="size-3.5" aria-hidden />
          )}
        </button>
      </div>

      {error === null ? null : (
        <p role="alert" className="px-1 text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-muted-foreground text-xs">
        {useLocal ? (
          <button
            type="button"
            onClick={() => {
              setUseLocal(false);
              setError(null);
            }}
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            Use an OpenRouter key instead
          </button>
        ) : (
          <>
            <a
              href={OPENROUTER_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Get a key →
            </a>
            <button
              type="button"
              onClick={() => {
                setUseLocal(true);
                setError(null);
              }}
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
            >
              Use a local server
            </button>
          </>
        )}
        <span className="ms-auto">Or pick another agent below.</span>
      </div>
    </form>
  );
}
