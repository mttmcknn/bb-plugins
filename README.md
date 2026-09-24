# bb plugins

Plugins for [bb](https://getbb.app). Each folder in `plugins/` is its own plugin.

| Plugin | What it does |
|---|---|
| `android-emulator` | Android emulators in the side panel |
| `env-panel` | Panel with a thread's changes, PR, stack, agent progress, and attachments, as a grid of tiles. Other plugins and scripts can add tiles (see `bb env-panel widgets help`). |
| `inbox` | Sidebar listing threads by day or by PR stack |
| `pr-stacks` | Open PRs grouped by repo and stack, linked to their threads |
| `thread-diff-viewer` | Review a thread's file changes by Git scope, with highlighted diffs and Markdown previews |

Install one:

    bb plugin install git:github.com/mttmcknn/bb-plugins@main --plugin <name>
