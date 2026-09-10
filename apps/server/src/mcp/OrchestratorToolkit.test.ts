import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  DEFAULT_THREAD_ORCHESTRATION,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { OrchestratorToolkit, OrchestratorToolkitHandlersLive } from "./OrchestratorToolkit.ts";

const account = ProviderInstanceId.make("claude_main");
const workerAccount = ProviderInstanceId.make("codex_backup");
const selection = { instanceId: account, model: "fable-test" };
const owner: OrchestrationThreadShell = {
  id: ThreadId.make("orchestrator"),
  projectId: ProjectId.make("project"),
  modelSelection: selection,
  orchestration: {
    mode: "delegated",
    workerAccountIds: [workerAccount],
    workerModels: [{ instanceId: workerAccount, model: "astra-test" }],
    fallbackAccountIds: [],
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  title: "Orchestrator test",
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const other = {
  ...owner,
  id: ThreadId.make("other-project-task"),
  projectId: ProjectId.make("another-project"),
};
const invocation = {
  environmentId: EnvironmentId.make("test-environment"),
  threadId: owner.id,
  providerInstanceId: account,
  providerSessionId: "native-session",
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

it.effect(
  "registers the tools, delegates with the selected native account, and denies project or capability escapes",
  () => {
    const commands: Array<OrchestrationCommand> = [];
    let currentOwner = owner;
    const settingsLayer = ServerSettingsService.layerTest({
      orchestratorModelSelection: null,
    });
    const layer = OrchestratorToolkitHandlersLive.pipe(
      Layer.provide(
        Layer.mock(OrchestrationEngineService, {
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery, {
          getThreadShellById: (threadId) =>
            Effect.succeed(Option.some(threadId === owner.id ? currentOwner : other)),
        }),
      ),
      Layer.provide(
        makeProviderRegistryLayer([
          {
            instanceId: workerAccount,
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            version: null,
            checkedAt: "2026-01-01T00:00:00.000Z",
            slashCommands: [],
            skills: [],
            models: [
              { slug: "astra-test", name: "Astra test", isCustom: false, capabilities: null },
              { slug: "other-model", name: "Not selected", isCustom: false, capabilities: null },
            ],
          },
        ]),
      ),
      Layer.provide(settingsLayer),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const registered = yield* Layer.build(
            McpServer.toolkit(OrchestratorToolkit).pipe(
              Layer.provideMerge(McpServer.McpServer.layer),
            ),
          );
          const server = Context.get(registered, McpServer.McpServer);
          const response = yield* server.callTool({ name: "t3_accounts", arguments: {} }).pipe(
            Effect.provideService(McpSchema.McpServerClient, {
              clientId: 1,
              clientCapabilities: {},
              clientInfo: { name: "codex-test", version: "1" },
              protocolVersion: "2025-06-18",
              initializePayload: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "codex-test", version: "1" },
              },
              getClient: Effect.die("unused"),
            }),
          );
          expect(response.isError).not.toBe(true);
          expect(response.structuredContent).toMatchObject({
            accounts: [{ instanceId: workerAccount, models: [{ id: "astra-test" }] }],
          });
        }),
      );
      expect(Tool.getJsonSchema(OrchestratorToolkit.tools.t3_delegate)).toMatchObject({
        properties: {
          modelSelection: {
            type: "object",
            required: ["instanceId", "model"],
            properties: { instanceId: { type: "string" }, model: { type: "string" } },
          },
        },
      });
      const toolkit = yield* OrchestratorToolkit;
      const delegated = yield* toolkit
        .handle("t3_delegate", {
          requestId: "implement-tests",
          title: "Implement tests",
          prompt: "Test the parser only.",
          modelSelection: { instanceId: workerAccount, model: "astra-test" },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(delegated[0]?.isFailure).toBe(false);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        projectId: owner.projectId,
        modelSelection: { instanceId: workerAccount, model: "astra-test" },
        runtimeMode: "approval-required",
        orchestration: { ...DEFAULT_THREAD_ORCHESTRATION, fallbackAccountIds: [] },
      });
      expect(commands[1]).toMatchObject({
        type: "thread.turn.start",
        message: { text: "Test the parser only." },
      });
      const unselectedModel = yield* toolkit
        .handle("t3_delegate", {
          requestId: "wrong-model",
          title: "Not allowed",
          prompt: "Do work",
          modelSelection: { instanceId: workerAccount, model: "other-model" },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(unselectedModel[0]?.isFailure).toBe(true);
      expect(commands).toHaveLength(2);
      // Starting another task does not require the first worker's result.
      const parallelWorker = yield* toolkit
        .handle("t3_delegate", {
          requestId: "independent-worker",
          title: "Independent work",
          prompt: "Review a separate module.",
          modelSelection: { instanceId: workerAccount, model: "astra-test" },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(parallelWorker[0]?.isFailure).toBe(false);
      expect(commands).toHaveLength(4);
      const createdWorkers = commands.filter((command) => command.type === "thread.create");
      expect(createdWorkers[1]?.threadId).not.toEqual(createdWorkers[0]?.threadId);
      const wrongProject = yield* toolkit
        .handle("t3_message_task", {
          threadId: other.id,
          requestId: "escape",
          action: "message",
          prompt: "Do work",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(wrongProject[0]?.isFailure).toBe(true);
      const noPermission = yield* toolkit.handle("t3_accounts", {}).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["preview"] as const),
        }),
      );
      expect(noPermission[0]?.isFailure).toBe(true);
      const wrongAccount = yield* toolkit.handle("t3_accounts", {}).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext, {
          ...invocation,
          providerInstanceId: workerAccount,
        }),
      );
      expect(wrongAccount[0]?.isFailure).toBe(true);
      expect(commands).toHaveLength(4);
      currentOwner = { ...owner, orchestration: { mode: "delegated", workerAccountIds: [] } };
      const filtered = yield* toolkit
        .handle("t3_accounts", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(filtered[0]?.result).toEqual({ accounts: [] });
      const denied = yield* toolkit
        .handle("t3_delegate", {
          requestId: "excluded-worker",
          title: "Excluded",
          prompt: "Do work",
          modelSelection: { instanceId: workerAccount, model: "astra-test" },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(denied[0]?.isFailure).toBe(true);
      expect(commands).toHaveLength(4);
      currentOwner = { ...owner, orchestration: DEFAULT_THREAD_ORCHESTRATION };
      const excludedOwner = yield* toolkit
        .handle("t3_accounts", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(excludedOwner[0]?.isFailure).toBe(true);
    }).pipe(
      Effect.provide(Layer.mergeAll(layer, settingsLayer)),
      Effect.provideService(McpInvocationContext, invocation),
    );
  },
);
