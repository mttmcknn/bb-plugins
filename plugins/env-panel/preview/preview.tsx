// Standalone render of the panel with fixture data, for visual review outside
// BB: `npm run preview`, then open preview/out/index.html.
import { createRoot } from "react-dom/client";
import type { Snapshot, StackPr } from "../core/types";
import { PanelFrame, type PanelActions } from "../views/panel";
import { BentoPanel, builtInTiles, widgetTiles } from "../views/bento";

const titles = [
  "[checkout] Show the redesigned cart summary",
  "[checkout] Animate items added to the cart",
  "[checkout] Keep the selected shipping option on rotation",
  "[checkout] Add address validation and retry states",
  "[checkout] Add a loading shimmer to the order total",
  "[checkout] Make the order summary accessible",
  "[checkout] Add the payment method picker",
  "[checkout] Add the cart, promo code, and total components",
  "[ui] Add a quantity stepper",
  "[navigation] Open checkout from the product page",
  "[theme] Add checkout color tokens",
];
const stack: StackPr[] = titles.map((title, index) => ({
  number: 159 - index,
  title,
  url: `https://github.com/acme/app/pull/${159 - index}`,
  headRefName: `octocat/checkout-v3-${11 - index}`,
  state: index === titles.length - 1 ? "merged" : "draft",
  checks: index < 6 ? "failing" : "passing",
  review: index === 9 ? "approved" : "none",
  isCurrent: index === 5,
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });

const snapshot: Snapshot = {
  threadId: "thr_preview",
  fetchedAt: new Date().toISOString(),
  environment: ok({
    id: "env_1",
    name: "app",
    kind: "managed-worktree",
    path: "/Users/you/.bb/worktrees/thr_preview/app",
    isWorktree: true,
    isGitRepo: true,
    branch: "octocat/checkout-v3-06-summary",
    baseBranch: "master",
  }),
  changes: ok({
    uncommitted: {
      files: [
        { path: "feature/checkout/src/main/kotlin/OrderSummary.kt", status: "M", insertions: 120, deletions: 14 },
        { path: "feature/checkout/src/test/kotlin/OrderSummaryTest.kt", status: "??", insertions: 46, deletions: 0 },
      ],
      insertions: 166,
      deletions: 14,
    },
    branch: {
      base: "master",
      ahead: 6,
      behind: 2,
      insertions: 10_000,
      deletions: 135,
      commits: [
        { shortSha: "4f6d92c", subject: "Make the order summary accessible" },
        { shortSha: "91ab03e", subject: "Announce total changes politely" },
      ],
    },
  }),
  pullRequest: ok({
    number: 154,
    title: "[checkout] Make the order summary accessible",
    url: "https://github.com/acme/app/pull/154",
    state: "draft",
    attention: "checks_failed",
    checks: { state: "failing", passed: 12, failed: 2, pending: 0, total: 14 },
    review: "none",
    mergeability: "draft",
    baseRefName: "octocat/checkout-v3-05",
  }),
  stack: ok({ number: 162, trunk: "master", prs: stack }),
  agent: ok({
    status: "active",
    goal: null,
    todos: {
      total: 5,
      done: 2,
      current: "Run the focused order summary tests",
      items: [
        { text: "Read the order summary component", status: "completed" },
        { text: "Announce total changes to screen readers", status: "completed" },
        { text: "Run the focused order summary tests", status: "in_progress" },
        { text: "Update screenshots", status: "pending" },
        { text: "Submit the stack", status: "pending" },
      ],
    },
    context: { usedTokens: 84_000, windowTokens: 200_000 },
    backgroundTasks: ["./gradlew :feature:checkout:testDebugUnitTest"],
  }),
  subagents: ok([
    { id: "sa-1", label: "Audit order summary accessibility", kind: "delegation", status: "done", threadId: null, providerId: null, summary: "No blocking issues.", background: true, startedAt: Date.now() - 400_000, endedAt: Date.now() - 200_000 },
    { id: "sa-2", label: "Check TalkBack order", kind: "delegation", status: "done", threadId: null, providerId: null, summary: null, background: true, startedAt: Date.now() - 300_000, endedAt: Date.now() - 100_000 },
    { id: "sa-3", label: "Verify screen recreation", kind: "delegation", status: "running", threadId: null, providerId: null, summary: null, background: true, startedAt: Date.now() - 90_000, endedAt: null },
  ]),
  scheduled: ok([
    { id: "a1", name: "Monitor checkout stack", enabled: true, schedule: "Every 10 minutes", nextRunAt: Date.now() + 4 * 60_000, lastRunAt: Date.now() - 6 * 60_000, lastRunStatus: "succeeded", lastRunThreadId: null, runCount: 12, relation: "targets" },
  ]),
  widgets: ok([
    { key: "script:android-devices:main", source: { kind: "script", name: "android-devices" }, title: "Devices", icon: "android", size: "wide", value: "3", caption: "3 ready of 3", tone: "positive", error: null, items: [{ label: "Pixel 9 API 36", detail: "Emulator · device", tone: "positive" }] },
  ]),
  attachments: ok({
    enriching: false,
    storageTruncated: false,
    items: [
      {
        origin: "branch",
        hint: null,
        ref: { id: "linear:ENG-421", kind: "linear", url: "https://linear.app/acme/issue/ENG-421", label: "ENG-421", identifier: "ENG-421" },
        detail: {
          kind: "linear",
          issue: {
            identifier: "ENG-421",
            title: "Checkout Redesign: accessible order summary",
            url: "https://linear.app/acme/issue/ENG-421",
            state: { name: "In Review", color: "#0f783c", type: "started" },
            priority: 2,
            priorityLabel: "High",
            assignee: { name: "Mona Octocat", avatarUrl: null },
            labels: [
              { name: "Checkout", color: "#5e6ad2" },
              { name: "a11y", color: "#f2994a" },
            ],
            team: "ENG",
            project: "Checkout Redesign",
            cycle: "Cycle 38",
            estimate: 3,
            dueDate: "2026-09-30",
            description:
              "## Goal\nScreen readers announce the order total **politely** when it changes, without re-reading the whole summary.\n\n- Live region for the total\n- Stable focus after payment\n- `contentDescription` for line items",
            children: [
              { identifier: "ENG-422", title: "Screen reader announcements", stateType: "completed" },
              { identifier: "ENG-423", title: "Focus restore after payment", stateType: "started" },
            ],
            links: [{ title: "acme/app#154", url: "https://github.com/acme/app/pull/154" }],
            updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
          },
        },
      },
      {
        origin: "message",
        hint: null,
        ref: { id: "notion:1", kind: "notion", url: "https://www.notion.so/x", label: "Checkout Redesign spec", pageId: "1" },
        detail: {
          kind: "notion",
          page: {
            title: "Checkout Redesign spec",
            url: "https://www.notion.so/x",
            icon: { emoji: "💬" },
            coverUrl: null,
            lastEditedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            excerpt: "The redesigned checkout keeps the total visible, validates addresses inline, and makes every step reachable by TalkBack.",
          },
        },
      },
      {
        origin: "message",
        hint: null,
        ref: { id: "github:acme/app#149", kind: "github", url: "https://github.com/acme/app/pull/149", label: "app#149", repo: "acme/app", number: 149, isPull: true },
        detail: {
          kind: "github",
          item: {
            title: "[theme] Add checkout color tokens",
            state: "draft",
            author: { login: "octocat", avatarUrl: null },
            labels: [{ name: "checkout", color: "#1d76db" }],
            comments: 3,
            updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
            excerpt: "Adds color tokens so checkout screens match the store theme.",
          },
        },
      },
      {
        origin: "message",
        hint: null,
        ref: { id: "web:1", kind: "web", url: "https://developer.android.com/develop/ui/views/layout/edge-to-edge", label: "developer.android.com/…" },
        detail: {
          kind: "web",
          preview: {
            title: "Display content edge-to-edge in views",
            description: "Implement an edge-to-edge display using traditional views, handling overlaps with system bars through insets.",
            siteName: "Android Developers",
            imageUrl: null,
          },
        },
      },
      { origin: "message", hint: null, detail: null, ref: { id: "figma:1", kind: "figma", url: "https://figma.com/design/1/Checkout-Redesign", label: "Checkout Redesign" } },
      { origin: "message", hint: "Add a Linear API key in the plugin settings to see ticket details.", detail: null, ref: { id: "linear:ENG-9", kind: "linear", url: "https://linear.app/acme/issue/ENG-9", label: "ENG-9", identifier: "ENG-9" } },
      { origin: "storage", hint: null, detail: null, ref: { id: "file:a.png", kind: "image", path: "screenshots/summary-before.png", label: "summary-before.png" } },
      { origin: "storage", hint: null, detail: null, ref: { id: "file:b.png", kind: "image", path: "screenshots/summary-after.png", label: "summary-after.png" } },
      { origin: "storage", hint: null, detail: null, ref: { id: "file:c.png", kind: "image", path: "screenshots/talkback.png", label: "talkback.png" } },
      { origin: "storage", hint: null, detail: null, ref: { id: "file:notes.md", kind: "file", path: "notes.md", label: "notes.md" } },
    ],
  }),
};

const actions: PanelActions = {
  Link: ({ href, className, title, children }) => (
    <a href={href} className={className} title={title} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  FileLink: ({ path, className, children }) => (
    <a href={`#${path}`} className={className}>
      {children}
    </a>
  ),
  Markdown: ({ content }) => <pre className="whitespace-pre-wrap font-sans text-xs">{content}</pre>,
  Thumbnail: ({ className, fallback }) =>
    fallback ?? <span className={className} style={{ background: "linear-gradient(135deg, #3b4252, #5e6ad2)" }} />,
  copy: () => undefined,
  openThread: () => undefined,
  widgetAction: () => undefined,
  commit: () => undefined,
  markReady: () => undefined,
  askAgent: () => undefined,
  busy: null,
};

createRoot(document.getElementById("root")!).render(
  <div className="h-screen bg-background">
    <PanelFrame docked style={{ left: 16, top: 16, width: 368 }} loading={false} updatedLabel="just now" onRefresh={() => undefined} onClose={() => undefined}>
      <BentoPanel tiles={[...builtInTiles(snapshot, actions), ...widgetTiles(snapshot, actions)]} editing={false} />
    </PanelFrame>
  </div>,
);
