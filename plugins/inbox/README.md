# bb-plugin-inbox

An inbox-style sidebar for bb.

- **Recent**: active threads first, then pinned, then by day (Today,
  Yesterday, Previous 7 days, Previous 30 days, then by month).
- **Stacks**: threads grouped by the open PR stack they contribute to, with
  a chip per PR in merge order, coloured by checks status.

Stack data comes from the [PR Stacks](../pr-stacks)
plugin (`pr-stacks`), which must be installed and enabled for the Stacks view.

## Use

1. `bb plugin install .`
2. Click **Switch sidebar list** (mail icon) in the sidebar footer and pick
   **Inbox**. Pick **bb** there to go back.
3. Use the Recent / Stacks toggle at the top of the list.

Right-click a row, or use its `…` button, to open in split, pin, mark
read/unread, archive, or delete.

## Develop

```
npm install --include=dev
npm test          # grouping logic
npm run typecheck
bb plugin build
```

Local types use `@get-bb/plugin-sdk@0.4.97`, the latest published version.
The running bb provides the real SDK at runtime. Fields newer than 0.4.97
(`href`, `displayTitle`, `isHidden`, `status`, `queuedWork`) are typed as
optional in `app.tsx`.
