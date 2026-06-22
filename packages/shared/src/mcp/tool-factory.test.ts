import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Principal } from "../uol/principal";
import { bindExecute, clearRegistry, defineOperation } from "../uol/registry";
import type { AccessRequirement, OperationDefinition } from "../uol/types";
import { buildAdminMcpTools } from "./tool-factory";
import { buildUserMcpTools } from "./user-tool-factory";

const apiKeyPrincipal = {
  type: "apiKey",
  userId: "user-1",
  apiKeyId: "key-1",
  plan: "pro",
  relayOnly: false,
} satisfies Principal;

const adminPrincipal = {
  type: "user",
  userId: "admin-1",
  role: "super_admin",
} satisfies Principal;

function registerOperation(
  overrides: Partial<OperationDefinition> & {
    name: string;
    access: AccessRequirement;
  }
) {
  return defineOperation({
    name: overrides.name,
    domain: overrides.domain ?? "image-generation",
    title: overrides.title ?? "Test Operation",
    description: overrides.description ?? "A test operation",
    input: overrides.input ?? z.object({}),
    output: overrides.output ?? z.object({ ok: z.boolean() }),
    access: overrides.access,
    readOnly: overrides.readOnly ?? false,
    destructive: overrides.destructive ?? false,
    idempotency: overrides.idempotency ?? { kind: "natural" },
    sideEffects: overrides.sideEffects ?? [],
    execute:
      overrides.execute ??
      (async () => {
        throw new Error(`Not yet wired: ${overrides.name}`);
      }),
  });
}

describe("MCP tool factories", () => {
  beforeEach(() => {
    clearRegistry();
    delete process.env.MCP_DENIED_OPS;
    delete process.env.MCP_READ_ONLY;
  });

  it("hides user tools until their UOL operation is bound", () => {
    registerOperation({
      name: "image.generate",
      access: { kind: "protected" },
    });

    expect(buildUserMcpTools(apiKeyPrincipal)).toHaveLength(0);

    bindExecute("image.generate", async () => ({ ok: true }));

    expect(buildUserMcpTools(apiKeyPrincipal).map((tool) => tool.name)).toEqual(
      ["image.generate"]
    );
  });

  it("hides admin tools until their UOL operation is bound", () => {
    registerOperation({
      name: "pool.getAdminPool",
      domain: "image-backend-pool",
      access: { kind: "imageBackendPoolViewer" },
      readOnly: true,
    });

    expect(buildAdminMcpTools(adminPrincipal)).toHaveLength(0);

    bindExecute("pool.getAdminPool", async () => ({ ok: true }));

    expect(buildAdminMcpTools(adminPrincipal).map((tool) => tool.name)).toEqual(
      ["pool_getAdminPool"]
    );
  });

  it("exposes bound update tools with destructive hints by default", () => {
    registerOperation({
      name: "update.status",
      domain: "update",
      access: { kind: "admin" },
      readOnly: true,
    });
    registerOperation({
      name: "update.apply",
      domain: "update",
      access: { kind: "admin" },
      destructive: true,
      input: z.object({
        runId: z.string(),
      }),
    });
    bindExecute("update.status", async () => ({ ok: true }));
    bindExecute("update.apply", async () => ({ ok: true }));

    const tools = buildAdminMcpTools(adminPrincipal);
    const statusTool = tools.find((tool) => tool.name === "update_status");
    const applyTool = tools.find((tool) => tool.name === "update_apply");

    expect(statusTool?.annotations?.readOnlyHint).toBe(true);
    expect(applyTool?.annotations?.destructiveHint).toBe(true);
    expect(applyTool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    });
  });

  it("hides destructive update_apply when MCP_READ_ONLY is truthy", () => {
    process.env.MCP_READ_ONLY = "1";
    registerOperation({
      name: "update.status",
      domain: "update",
      access: { kind: "admin" },
      readOnly: true,
    });
    registerOperation({
      name: "update.apply",
      domain: "update",
      access: { kind: "admin" },
      destructive: true,
    });
    bindExecute("update.status", async () => ({ ok: true }));
    bindExecute("update.apply", async () => ({ ok: true }));

    const toolNames = buildAdminMcpTools(adminPrincipal).map(
      (tool) => tool.name
    );

    expect(toolNames).toContain("update_status");
    expect(toolNames).not.toContain("update_apply");
  });

  it("hides update_apply when MCP_DENIED_OPS includes update.apply", () => {
    process.env.MCP_DENIED_OPS = "update.apply";
    registerOperation({
      name: "update.status",
      domain: "update",
      access: { kind: "admin" },
      readOnly: true,
    });
    registerOperation({
      name: "update.apply",
      domain: "update",
      access: { kind: "admin" },
      destructive: true,
    });
    bindExecute("update.status", async () => ({ ok: true }));
    bindExecute("update.apply", async () => ({ ok: true }));

    const toolNames = buildAdminMcpTools(adminPrincipal).map(
      (tool) => tool.name
    );

    expect(toolNames).toContain("update_status");
    expect(toolNames).not.toContain("update_apply");
  });

  it("hides unbound update_apply stubs", () => {
    registerOperation({
      name: "update.apply",
      domain: "update",
      access: { kind: "admin" },
      destructive: true,
    });

    expect(
      buildAdminMcpTools(adminPrincipal).map((tool) => tool.name)
    ).not.toContain("update_apply");
  });
});
