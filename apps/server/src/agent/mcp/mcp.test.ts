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

describe("parseToolList", () => {
  it("reads a well-formed list", () => {
    const tools = parseToolList({
      tools: [{ name: "search", description: "searches", inputSchema: { type: "object" } }],
    });
    expect(tools).toEqual([
      { name: "search", description: "searches", inputSchema: { type: "object" } },
    ]);
  });

  it("drops a malformed entry without losing the rest", () => {
    // One bad tool must not cost the user every other tool on that server.
    const tools = parseToolList({
      tools: [null, { description: "no name" }, { name: "good" }, 42],
    });
    expect(tools.map((tool) => tool.name)).toEqual(["good"]);
  });

  it("falls back to the name when a description is missing", () => {
    expect(parseToolList({ tools: [{ name: "solo" }] })[0]?.description).toBe("solo");
  });

  it("returns nothing for a result that is not a list", () => {
    expect(parseToolList({})).toEqual([]);
    expect(parseToolList(null)).toEqual([]);
    expect(parseToolList({ tools: "nope" })).toEqual([]);
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

  it("survives a result with no content at all", () => {
    expect(renderToolResult({})).toEqual({ text: "", isError: false });
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
