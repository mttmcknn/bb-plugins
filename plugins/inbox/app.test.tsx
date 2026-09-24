import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { StacksResult } from "./server";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function thread(id: string, title: string, updatedAt: number, extra: Partial<PluginSidebarThread> = {}) {
  return {
    id,
    projectId: "proj_1",
    title,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude-code",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: updatedAt,
    updatedAt,
    lastReadAt: null,
    latestAttentionAt: updatedAt,
    ...extra,
  } satisfies PluginSidebarThread;
}

const threads = [
  thread("t_run", "Running thread", NOW - 40 * HOUR, { indicator: "runtime" }),
  thread("t_today", "Today thread", NOW - 60_000),
  thread("t_old", "Old thread", NOW - 24 * 24 * HOUR),
  thread("t_stack", "Stack thread", NOW - 2 * 60_000),
];

const stacksResult: StacksResult = {
  available: true,
  error: null,
  fetchedAt: new Date(NOW).toISOString(),
  stacks: [
    {
      id: "o/r#1",
      title: "Checkout flow",
      repo: "o/r",
      base: "main",
      prs: [
        { number: 1, title: "one", url: "u1", isDraft: false, checks: "passing", review: "none", conflicts: false, threadId: "t_stack" },
        { number: 2, title: "two", url: "u2", isDraft: true, checks: "failing", review: "none", conflicts: false, threadId: "t_stack" },
        { number: 3, title: "three", url: "u3", isDraft: false, checks: "none", review: "none", conflicts: false, threadId: null },
      ],
    },
  ],
};

let registration: { component: React.ComponentType<PluginThreadListProps> };
const props: PluginThreadListProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
};

beforeEach(async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  const list = app.threadLists[0];
  if (list === undefined) throw new Error("no thread list registered");
  registration = list;
});
afterEach(cleanup);

const sectionOf = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest("section")!;

test("Recent view groups active threads first, then by day", () => {
  renderSlot(registration, props, { sidebarThreads: { status: "ready", threads, projects: [] } });
  const headers = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
  expect(headers).toEqual(["Active1", "Today2", "Previous 30 days1"]);
  expect(sectionOf("Active").textContent).toContain("Running thread");
  expect(sectionOf("Today").textContent).toMatch(/Today thread.*Stack thread|Stack thread.*Today thread/);
});

test("Stacks view groups a thread under its stack with PR chips", async () => {
  renderSlot(registration, props, {
    sidebarThreads: { status: "ready", threads, projects: [] },
    rpc: { stacks: () => stacksResult },
  });
  fireEvent.click(screen.getByRole("radio", { name: /Stacks/ }));
  await waitFor(() => screen.getByText("Checkout flow"));
  const stack = sectionOf("Checkout flow");
  expect(stack.textContent).toContain("Stack thread");
  expect(stack.textContent).toContain("#1");
  expect(stack.textContent).toContain("#2");
  expect(stack.textContent).toContain("1 PR without a thread");
  const loose = sectionOf("Not in a stack");
  expect(loose.textContent).toContain("Running thread");
  expect(loose.textContent).not.toContain("Stack thread");
  expect(localStorage.getItem("bb-plugin-inbox:mode")).toBe('"stacks"');
});

test("Stacks view explains when PR Stacks is unavailable", async () => {
  renderSlot(registration, props, {
    sidebarThreads: { status: "ready", threads, projects: [] },
    rpc: { stacks: () => ({ available: false, error: "unknown plugin", fetchedAt: null, stacks: [] }) },
  });
  fireEvent.click(screen.getByRole("radio", { name: /Stacks/ }));
  await waitFor(() => screen.getByText(/PR Stacks plugin/));
  expect(sectionOf("Not in a stack").textContent).toContain("Today thread");
});

test("row menu pins and archives through host actions", () => {
  const view = renderSlot(registration, props, { sidebarThreads: { status: "ready", threads, projects: [] } });
  fireEvent.click(screen.getByRole("button", { name: "Actions for Old thread" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
  fireEvent.contextMenu(screen.getByText("Old thread"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
  expect(view.inspection.sidebarActionCalls.map((call) => [call.method, call.threadId, call.pinned])).toEqual([
    ["setPinned", "t_old", true],
    ["archive", "t_old", undefined],
  ]);
});

test("footer switch shows the current list and switches to the other", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const item = app.experimentalSidebarFooterItems.find((entry) => entry.id === "sidebar-list");
  if (item === undefined || item.kind !== "disclosure") throw new Error("no footer switch registered");
  let dismissed = 0;
  const view = renderSlot(item, { dismiss: () => void (dismissed += 1) }, {
    rpc: {
      sidebarList: () => ({ list: "bb" as const }),
      setSidebarList: ({ list }: { list: "bb" | "inbox" }) => ({ list }),
    },
  });
  await waitFor(() => expect(screen.getByRole("radio", { name: /bb/ }).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(screen.getByRole("radio", { name: /Inbox/ }));
  await waitFor(() => expect(dismissed).toBe(1));
  expect(view.inspection.rpcCalls.map((call) => [call.method, call.input])).toEqual([
    ["sidebarList", null],
    ["setSidebarList", { list: "inbox" }],
  ]);
});
