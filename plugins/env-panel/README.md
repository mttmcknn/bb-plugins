# bb-plugin-env-panel

A floating Environment panel for bb threads. See PLUGIN_OVERVIEW.md.

    npm install --include=dev --ignore-scripts
    npm test            # core logic (stack, sources)
    npm run typecheck
    bb plugin build .
    bb plugin install .  # or: bb plugin reload env-panel
    npm run preview      # fixture render in preview/out/index.html

Layout: `core/` holds pure logic and CLI readers, `server.ts` builds snapshots
and RPCs, `views/panel.tsx` holds the pure view, and `app.tsx` holds the header
button, overlay, and snapshot store.
