export const relayTools = [
  {
    type: "function",
    name: "relay_spec_read",
    description: "Read the assigned system Spec draft or immutable version.",
    inputSchema: {
      type: "object",
      properties: {
        specId: { type: "string" },
        document: { type: "string", enum: ["product", "tech"] },
        versionId: { type: "string" },
      },
      required: ["specId", "document"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "relay_report",
    description:
      "Atomically publish an immutable PRODUCT/TECH pair and request Human approval, report actual artifacts, ask scoped questions, or answer the assigned request. Does not approve or upgrade anything. End the turn after creating a blocking proposal.",
    inputSchema: {
      type: "object",
      properties: {
        specProposal: {
          type: "object",
          properties: {
            specId: { type: "string" },
            baseVersionId: { type: "string" },
            draftRevision: { type: "integer", minimum: 0 },
            product: { type: "string" },
            tech: { type: "string" },
            upgradeTargets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  worktreeId: { type: "string" },
                  fromVersionId: { type: "string" },
                  worktreeRevision: { type: "integer" },
                },
                required: ["worktreeId", "fromVersionId", "worktreeRevision"],
              },
            },
          },
          required: [
            "specId",
            "baseVersionId",
            "draftRevision",
            "product",
            "tech",
            "upgradeTargets",
          ],
        },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              title: { type: "string" },
              content: { type: "string" },
              supersedesId: { type: "string" },
            },
            required: ["kind", "title", "content"],
          },
        },
        requests: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["input", "approval"] },
              title: { type: "string" },
              body: { type: "string" },
              scope: {
                type: "object",
                properties: {
                  taskIds: { type: "array", items: { type: "string" } },
                  bindingIds: { type: "array", items: { type: "string" } },
                  worktreeIds: { type: "array", items: { type: "string" } },
                },
                required: ["taskIds", "bindingIds", "worktreeIds"],
              },
              artifactIndexes: { type: "array", items: { type: "integer" } },
              action: {
                type: "object",
                properties: {
                  type: { const: "review" },
                  description: { type: "string" },
                },
                required: ["type", "description"],
              },
              routeToAgent: { type: "boolean" },
              supersedesId: { type: "string" },
            },
            required: ["kind", "title", "body"],
          },
        },
        answer: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            text: { type: "string" },
          },
          required: ["requestId", "text"],
        },
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              dependencyIds: { type: "array", items: { type: "string" } },
            },
            required: ["text"],
          },
        },
      },
      additionalProperties: false,
    },
  },
];
