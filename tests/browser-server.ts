import express from "express";
import { resolve } from "node:path";
import { Store } from "../server/store.js";
import { Orchestrator } from "../server/orchestrator.js";
import { createApp } from "../server/app.js";
const store = new Store(process.env.TEST_DB!);
const engine = new Orchestrator(
  store,
  {
    route: async (d) => {
      if (
        d.title === "Human answer placement" &&
        !d.requests.some((r) => r.status === "answered")
      ) {
        for (let index = 0; index < 60; index++)
          store.activity(
            d.id,
            "System",
            "progress",
            `Previous activity ${index + 1}`,
          );
        return { action: "human", detail: "Which workspace should we use?" };
      }
      if (
        d.turns.filter((t) => t.status === "completed").length >=
        d.bindings.length
      )
        return { action: "done", detail: "All work verified" };
      return {
        action: "agent",
        bindingId:
          d.bindings[d.turns.filter((t) => t.status === "completed").length].id,
        detail: "Work within your assigned responsibility",
      };
    },
  },
  (b, p, cb) => {
    let timer: NodeJS.Timeout;
    const handle = {
      send: async (message: string) => {
        cb.message("assistant_delta", `Received: ${message}`);
      },
      stop: async () => {
        clearTimeout(timer);
        cb.closed();
      },
      respond: () => {
        timer = setTimeout(() => {
          cb.message("assistant_delta", `${b.name} completed the task.`);
          cb.complete("Task completed and verified.");
          cb.closed();
        }, 200);
      },
      dispose: () => clearTimeout(timer),
    };
    if (b.approvalLevel === "automatic") {
      timer = setTimeout(() => {
        cb.complete("Automatic work completed.");
        cb.closed();
      }, 1500);
      return handle;
    }
    timer = setTimeout(() => {
      cb.message(
        "assistant_delta",
        "I have reviewed the issue and prepared the proposed changes.",
      );
      cb.request({
        kind: "approval",
        title: "Approve proposed implementation",
        detail:
          "Update the issue workspace and run verification.\nProposed change: add API routes and persist workflow state.",
        options: [],
        native: { id: "fixture-approval" },
      });
    }, 100);
    return handle;
  },
);
const app = createApp(engine);
app.use(express.static(resolve("dist")));
app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
app.listen(Number(process.env.PORT), "127.0.0.1");
