import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpServer, Tool } from "effect/unstable/ai";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { OrchestratorToolkit, OrchestratorToolkitHandlersLive } from "./OrchestratorToolkit.ts";

const account = ProviderInstanceId.make("claude_main");
const workerAccount = ProviderInstanceId.make("codex_backup");
const selection = { instanceId: account, model: "fable-test" };
const owner = {
  id: ThreadId.make("orchestrator"),
  projectId: ProjectId.make("project"),
  modelSelection: selection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
} as OrchestrationThreadShell;
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
            Effect.succeed(Option.some(threadId === owner.id ? owner : other)),
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
            ],
          },
        ]),
      ),
      Layer.provide(ServerSettingsService.layerTest({ orchestratorModelSelection: selection })),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(McpServer.toolkit(OrchestratorToolkit)));
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
      });
      expect(commands[1]).toMatchObject({
        type: "thread.turn.start",
        message: { text: "Test the parser only." },
      });
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
      expect(commands).toHaveLength(2);
    }).pipe(Effect.provide(layer), Effect.provideService(McpInvocationContext, invocation));
  },
);
