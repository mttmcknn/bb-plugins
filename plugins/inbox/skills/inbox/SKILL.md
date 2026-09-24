---
name: inbox
description: Explain or troubleshoot the Inbox sidebar plugin, which lists threads by day or by PR stack. Use when the user asks how the inbox sidebar groups threads, why a thread is missing from a stack, or how to switch sidebar lists.
---

# Inbox sidebar

The Inbox plugin replaces the sidebar thread list. It has two views, chosen
with the toggle at the top of the list. The choice is saved per client.

- **Recent** — sections in this order:
  1. **Active**: the agent is running, queued, running background work, or
     waiting for the user.
  2. **Pinned**.
  3. Day buckets by last update: Today, Yesterday, Previous 7 days,
     Previous 30 days, then one section per month.
- **Stacks** — one section per open PR stack, most recently updated first.
  Each row is a thread, with chips for the PRs it owns, in merge order. Chip
  colour shows checks: green passing, red failing, amber pending, dashed
  border for drafts. Threads with no PR in a stack are under **Not in a
  stack**.

Archived and hidden threads are not listed.

## Where stack data comes from

The Stacks view reads the **PR Stacks** plugin (`pr-stacks`) over plugin RPC.
PR Stacks fetches open PRs with `gh` and matches each PR to a thread.
It refreshes every 60 seconds while the Stacks view is open.

- A thread missing from its stack means PR Stacks has not linked the PR.
  Link it with `bb pr-stacks link <pr-url> --thread <thread-id>`.
- Rename a stack with `bb pr-stacks name <pr-url> <title>`.
- If PR Stacks is disabled or missing, the Stacks view says so and lists
  every thread under **Not in a stack**.

## Switching between Inbox and bb's list

The plugin adds a **Switch sidebar list** button (mail icon) to the sidebar
footer. It opens a bb / Inbox picker and stays visible under either list.

The choice is the server-synced UI preference `sidebar.threadListProvider`:
`inbox/inbox` for Inbox, `thread-list/thread-list` for bb's list. It syncs to
every bb window. From a terminal:

    bb settings ui set sidebar.threadListProvider inbox/inbox
    bb settings ui set sidebar.threadListProvider thread-list/thread-list

Settings → Appearance → Sidebar sets the same preference.
