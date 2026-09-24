Run Android emulators beside your agent threads, with the controls you know
from Android Studio's Running Devices window.

## What you get

- An **Android Emulator** tab in the thread side panel. Open it from the
  panel's new-tab Actions list.
- One tab per running emulator. Click, drag, scroll, and type on the screen.
  Hold Option while dragging to pinch.
- A toolbar with power, volume, rotate left and right, back, home, overview,
  device UI settings (dark theme, font size, display size, gesture
  navigation, layout bounds, show taps), mouse input mode, screenshot, screen
  recording, APK install and file upload, a file browser for downloads,
  snapshots, and extended controls.
- A device manager to start, stop, cold boot, wipe, duplicate, delete, and
  create virtual devices.
- `bb android-emulator list | start | stop` for agents and terminals.

## How it works

The plugin starts emulators with the same headless gRPC mode Android Studio
uses. It streams the screen into the panel and sends your input back. It
needs the Android SDK, with the Emulator package and at least one system
image, on the machine that runs the BB server.

Quitting BB shuts down the emulators BB started. Turn this off with the
**Stop emulators when BB quits** setting.
