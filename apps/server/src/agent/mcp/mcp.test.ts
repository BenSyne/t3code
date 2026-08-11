import { describe, expect, it } from "vite-plus/test";

import { qualifiedName } from "./mcpTools.ts";
import { parseToolList, renderToolResult } from "./protocol.ts";
import { enabledServers, type McpServers } from "./serverConfig.ts";

describe("enabledServers", () => {
  const servers = {
    zebra: { transport: "stdio", command: "z" },
    alpha: { transport: "stdio", command: "a" },
    off: { transport: "stdio", command: "o", enabled: false },
  } as unknown as McpServers;

  it("skips servers the user switched off", () => {
    expect(enabledServers(servers).map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
  });

  it("treats a missing enabled flag as on", () => {
    const implicit = { one: { transport: "stdio", command: "x" } } as unknown as McpServers;
    expect(enabledServers(implicit)).toHaveLength(1);
  });

  it("orders by name, so tool precedence does not depend on key order", () => {
    expect(enabledServers(servers)[0]?.name).toBe("alpha");
  });
});

/** The catalogue, or a failure if the envelope did not decode. */
const toolsOf = (result: unknown) => {
  const outcome = parseToolList(result);
  if (outcome._tag === "Unreadable") {
    throw new Error(`expected tools, got Unreadable: ${outcome.reason}`);
  }
  return outcome.tools;
};

describe("parseToolList", () => {
  it("reads a well-formed list", () => {
    expect(
      toolsOf({
        tools: [{ name: "search", description: "searches", inputSchema: { type: "object" } }],
      }),
    ).toEqual([{ name: "search", description: "searches", inputSchema: { type: "object" } }]);
  });

  it("drops a malformed entry without losing the rest", () => {
    // One bad tool must not cost the user every other tool on that server.
    const tools = toolsOf({
      tools: [null, { description: "no name" }, { name: "good", inputSchema: {} }, 42],
    });
    expect(tools.map((tool) => tool.name)).toEqual(["good"]);
  });

  it("falls back to the name when a description is missing", () => {
    expect(toolsOf({ tools: [{ name: "solo", inputSchema: {} }] })[0]?.description).toBe("solo");
  });

  it("reports an unreadable envelope rather than an empty catalogue", () => {
    // The distinction this whole shape exists for. A server we cannot parse is
    // not a server offering no tools, and reporting it as the latter is how a
    // broken connection comes to look like a working one.
    for (const bad of [{}, null, { tools: "nope" }, "garbage"]) {
      expect(parseToolList(bad)._tag).toBe("Unreadable");
    }
  });

  it("still reports an empty catalogue as tools, not as a failure", () => {
    // A server legitimately offering nothing is well-formed and must not be
    // mistaken for a broken one.
    expect(parseToolList({ tools: [] })).toEqual({ _tag: "Tools", tools: [] });
  });
});

describe("renderToolResult", () => {
  it("joins text blocks", () => {
    const rendered = renderToolResult({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(rendered).toEqual({ text: "first\nsecond", isError: false });
  });

  it("names a non-text block rather than dropping or embedding it", () => {
    // Embedding base64 would spend the context; dropping it silently would make
    // the model think the tool returned nothing.
    const rendered = renderToolResult({
      content: [{ type: "image", data: "iVBORw0KGgo=" }],
    });
    expect(rendered.text).toBe("[image content]");
  });

  it("carries the error flag through", () => {
    expect(renderToolResult({ content: [], isError: true }).isError).toBe(true);
  });

  it("keeps the good blocks when one is malformed", () => {
    // Caught by this test failing during the schema rework: decoding the whole
    // result strictly meant an image missing its mimeType discarded the text
    // blocks either side of it, and the model was told the tool was unreadable
    // when nearly all of it was fine.
    const rendered = renderToolResult({
      content: [
        { type: "text", text: "before" },
        { type: "image", data: "iVBORw0KGgo=" },
        { type: "text", text: "after" },
      ],
    });
    expect(rendered.text).toBe("before\n[image content]\nafter");
    expect(rendered.isError).toBe(false);
  });

  it("names a block with no recognisable type at all", () => {
    expect(renderToolResult({ content: [{ nonsense: true }] }).text).toBe("[unknown content]");
  });

  it("treats a result it cannot read as an error, not as silence", () => {
    // A tool that answered with nothing and a tool that answered with nonsense
    // call for different reactions from the model.
    const rendered = renderToolResult({ nonsense: true });
    expect(rendered.isError).toBe(true);
    expect(rendered.text).toContain("could not read");
  });

  it("reads an empty content list as genuinely empty output", () => {
    expect(renderToolResult({ content: [] })).toEqual({ text: "", isError: false });
  });
});

describe("qualifiedName", () => {
  it("namespaces a tool by its server", () => {
    // Two servers both offering `search` is common; without this one silently
    // wins and the user cannot see why.
    expect(qualifiedName("github", "search")).toBe("mcp__github__search");
  });

  it("replaces characters a model would struggle to reproduce", () => {
    expect(qualifiedName("my server!", "do/thing")).toBe("mcp__my_server___do_thing");
  });
});
