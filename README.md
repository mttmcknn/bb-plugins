# bb plugins

Plugins for [bb](https://getbb.app). Each folder in `plugins/` is its own plugin.

| Plugin | What it does |
|---|---|
| `android-emulator` | Android emulators in the side panel |
| `env-panel` | Floating panel with a thread's changes, PR, stack, agent progress, and attachments |
| `inbox` | Sidebar listing threads by day or by PR stack |
| `pr-stacks` | Open PRs grouped by repo and stack, linked to their threads |

Install one:

    bb plugin install git:github.com/mttmcknn/bb-plugins@main --plugin <name>
