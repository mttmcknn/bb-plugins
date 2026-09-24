---
name: android-emulator
description: Start, stop, and list the Android emulators shown in BB's Android Emulator side panel. Use when the user wants an emulator running beside the thread, or asks which emulators are available.
---

# Android Emulator panel

The Android Emulator plugin runs emulators headless and shows them in the
thread side panel (new tab → Actions → **Android Emulator**). The user
interacts with the screen there directly.

## Commands

- `bb android-emulator list [--json]` — every AVD with its status
  (`stopped`, `starting`, `booting`, `running`) and adb serial.
- `bb android-emulator start <avd-id> [--cold-boot]` — start an AVD so it
  appears in the panel. Use the ID from `list`, not the display name.
- `bb android-emulator stop <avd-id>` — shut the emulator down cleanly.

## Working with a running emulator

Use `adb -s <serial>` with the serial from `list` to install builds, run
instrumentation, or read logcat. The panel picks up changes on its own.

Emulators started here keep running after the thread ends, until BB quits
(unless the user turned off "Stop emulators when BB quits"). Stop them
earlier only when the user asks.
