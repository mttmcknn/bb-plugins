# bb-plugin-android-emulator

Android emulators in BB's thread side panel, with Android Studio-style
controls.

## Requirements

- The BB server runs on the same machine as the Android SDK.
- The Android SDK has the **Android Emulator** package (the plugin reads its
  gRPC `.proto` files from `emulator/lib`) and at least one system image.
- `platform-tools/adb` in the SDK, or `adb` on `PATH`.

The SDK path comes from the **Android SDK path** setting, then
`ANDROID_HOME`, `ANDROID_SDK_ROOT`, and `~/Library/Android/sdk`.

## Use it

1. Install: `bb plugin install .`
2. Open a thread, open the side panel's new-tab menu, and choose **Android
   Emulator** under Actions.
3. Start a device from the **+** menu or the **Devices** tab.

Screen input:

- Click and drag: touch. The cursor is a translucent fingertip circle.
  Hold Option (Alt) while dragging: two-finger pinch.
- Scroll: mouse wheel.
- Typing while the screen has focus sends keys. Pasting sends ASCII text as
  keystrokes. Other text goes to the device clipboard.
- Drop files on the screen: `.apk` files are installed, other files are
  copied to `/sdcard/Download`.
- The keyboard-and-mouse button switches clicks from touches to mouse events
  (hover, right click).

## Layout

- `server.ts` — RPC contract, WebSocket and download routes, CLI, device
  watcher.
- `server/emulators.ts` — discovery (`pid_*.ini`), gRPC clients, launch/stop.
- `server/session.ts` — the live screen socket: frames out, input in, and
  rotation-aware coordinate mapping.
- `server/avds.ts` — AVD listing, creation, duplication, deletion.
- `ui/` — the side panel: tabs, toolbar, screen canvas, device manager.

## How it talks to the emulator

Emulators start with `-qt-hide-window -grpc-use-token`, the same flags Android
Studio uses for embedded emulators. Each one writes its gRPC port and token
to a discovery file. The server streams PNG frames with `streamScreenshot`,
sized to the panel. The client acknowledges each frame, so a slow client
always gets the newest frame. Input goes through `streamInputEvent`. Touch
coordinates use the device's natural orientation, so the server maps them
through the current rotation.

Up to two frames are in flight, so the next frame transfers while the panel
decodes the current one. Pointer moves are sent at most once per animation
frame, repeated same-size resizes don't restart the stream, and the stream
pauses while BB is hidden. The emulator's PNG encoding sets the frame-rate
ceiling: about 56 fps at 500 px wide and about 47 fps at 740 px.

SystemUI draws the display's rounded corners as black pixels in each frame.
The panel reads the corner radii from `dumpsys display` and clips the canvas
to them, so every device shows its own corner shape, in any rotation.

Emulators that Android Studio or the command line started also appear in
the panel, if they have gRPC enabled.

## Quitting BB

With **Stop emulators when BB quits** on (the default), every emulator
started from BB gets a small watchdog shell process. It checks every 2
seconds whether the BB server process is still alive. When the server is
gone (quit, crash, or force quit), the watchdog sends SIGTERM to the
emulator's process group. The emulator shuts down cleanly and saves its
Quick Boot state. If anything in the group is still alive after 30 seconds,
the watchdog sends SIGKILL.

Plugin reloads keep the same server process, so they never stop emulators.
Emulators started outside BB have no watchdog and keep running. The setting
applies to emulators started after you change it.

## Develop

```sh
npm install --include=dev
npx tsc -p .
bb plugin build
bb plugin dev   # rebuild and reload on save
```
