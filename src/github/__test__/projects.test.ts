import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import {
  addItemToProject,
  buildStatusOptionIds,
  ensureStatusOptions,
  getItem,
  resolveStatusField,
  setStatus,
} from "../projects.js";

type Call = { query: string; variables?: Record<string, unknown> };

function makeGql(responses: unknown[]) {
  const calls: Call[] = [];
  let i = 0;
  const gql = async <T>(query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, ...(variables !== undefined ? { variables } : {}) });
    if (i >= responses.length) throw new Error("unexpected call");
    return responses[i++] as T;
  };
  return { gql: gql as never, calls };
}

describe("resolveStatusField", () => {
  it("returns fieldId and option map", async () => {
    const { gql } = makeGql([
      {
        node: {
          fields: {
            nodes: [
              { __typename: "ProjectV2Field", id: "F0", name: "Title" },
              {
                __typename: "ProjectV2SingleSelectField",
                id: "F1",
                name: "Status",
                options: [
                  { id: "o1", name: "Backlog" },
                  { id: "o2", name: "Ready" },
                ],
              },
            ],
          },
        },
      },
    ]);
    const r = await resolveStatusField(gql, "PVT_1", "Status");
    expect(r.fieldId).toBe("F1");
    expect(r.options).toEqual({ o1: "Backlog", o2: "Ready" });
  });

  it("throws ConfigError when the field is missing", async () => {
    const { gql } = makeGql([
      { node: { fields: { nodes: [] } } },
    ]);
    await expect(resolveStatusField(gql, "PVT_1", "Status")).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe("buildStatusOptionIds", () => {
  it("only includes canonical status names", () => {
    const out = buildStatusOptionIds({ a: "Backlog", b: "Custom", c: "Ready" });
    expect(out).toEqual({ Backlog: "a", Ready: "c" });
  });
});

describe("ensureStatusOptions", () => {
  it("no mutation when all options present", async () => {
    const existing: Record<string, string> = {
      a: "Backlog",
      b: "Refinement",
      c: "Refined",
      d: "Ready",
      e: "In progress",
      f: "In review",
      g: "Ready to merge",
      h: "Blocked",
    };
    const { gql, calls } = makeGql([]);
    const resolved = await ensureStatusOptions(gql, {
      fieldId: "F1",
      existingOptions: existing,
      manage: true,
    });
    expect(calls).toHaveLength(0);
    expect(resolved.statusOptionIds.Backlog).toBe("a");
    expect(resolved.statusOptionIds["Ready to merge"]).toBe("g");
    expect(resolved.statusOptionIds.Blocked).toBe("h");
  });

  it("sends one mutation adding missing options (existing preserved)", async () => {
    const existing = { a: "Backlog" };
    const { gql, calls } = makeGql([
      {
        updateProjectV2Field: {
          projectV2Field: {
            id: "F1",
            options: [
              { id: "a", name: "Backlog" },
              { id: "new1", name: "Refinement" },
              { id: "new2", name: "Refined" },
              { id: "new3", name: "Ready" },
              { id: "new4", name: "In progress" },
              { id: "new5", name: "In review" },
              { id: "new6", name: "Ready to merge" },
              { id: "new7", name: "Blocked" },
            ],
          },
        },
      },
    ]);
    const resolved = await ensureStatusOptions(gql, {
      fieldId: "F1",
      existingOptions: existing,
      manage: true,
    });
    expect(calls).toHaveLength(1);
    const input = (calls[0]!.variables as { input: { singleSelectOptions: Array<{ name: string }> } })
      .input.singleSelectOptions;
    expect(input.map((o) => o.name)).toContain("Backlog");
    expect(input.map((o) => o.name)).toContain("Ready to merge");
    expect(input.map((o) => o.name)).toContain("Blocked");
    expect(resolved.statusOptionIds["Ready to merge"]).toBe("new6");
    expect(resolved.statusOptionIds.Blocked).toBe("new7");
  });

  it("throws ConfigError when missing and manage=false", async () => {
    const { gql } = makeGql([]);
    await expect(
      ensureStatusOptions(gql, {
        fieldId: "F1",
        existingOptions: { a: "Backlog" },
        manage: false,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("setStatus", () => {
  it("sends the expected mutation", async () => {
    const { gql, calls } = makeGql([{ updateProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } }]);
    await setStatus(gql, {
      projectNodeId: "PVT_1",
      itemId: "PVTI_1",
      fieldId: "F1",
      optionId: "opt-ready",
    });
    const vars = calls[0]!.variables as { input: { value: { singleSelectOptionId: string } } };
    expect(vars.input.value.singleSelectOptionId).toBe("opt-ready");
  });
});

describe("addItemToProject", () => {
  it("sends the expected mutation", async () => {
    const { gql, calls } = makeGql([
      { addProjectV2ItemById: { item: { id: "PVTI_99" } } },
    ]);

    const result = await addItemToProject(gql, {
      projectNodeId: "PVT_1",
      contentNodeId: "I_42",
    });

    expect(result.itemId).toBe("PVTI_99");
    const vars = calls[0]!.variables as {
      input: { projectId: string; contentId: string };
    };
    expect(vars.input.projectId).toBe("PVT_1");
    expect(vars.input.contentId).toBe("I_42");
  });
});

describe("getItem", () => {
  it("returns a parsed ProjectItem with issue number and status", async () => {
    const { gql } = makeGql([
      {
        node: {
          id: "PVTI_1",
          project: { id: "PVT_1" },
          content: { __typename: "Issue", number: 42 },
          fieldValues: {
            nodes: [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue",
                name: "Ready",
                field: { id: "F1", name: "Status" },
              },
            ],
          },
        },
      },
    ]);
    const item = await getItem(gql, { itemId: "PVTI_1", statusFieldName: "Status" });
    expect(item.itemId).toBe("PVTI_1");
    expect(item.issueNumber).toBe(42);
    expect(item.status).toBe("Ready");
  });

  it("omits status when not a canonical name", async () => {
    const { gql } = makeGql([
      {
        node: {
          id: "PVTI_1",
          project: { id: "PVT_1" },
          content: { __typename: "Issue", number: 1 },
          fieldValues: {
            nodes: [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue",
                name: "Mystery",
                field: { id: "F1", name: "Status" },
              },
            ],
          },
        },
      },
    ]);
    const item = await getItem(gql, { itemId: "PVTI_1", statusFieldName: "Status" });
    expect(item.status).toBeUndefined();
  });
});
