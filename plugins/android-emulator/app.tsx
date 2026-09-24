// bb-plugin-android-emulator — frontend entry.
//
// Adds "Android Emulator" to the thread side panel's new-tab Actions list (and
// the New thread screen's). The tab hosts running emulators with Android
// Studio-style controls; see ui/EmulatorPanel.tsx.
import { definePluginApp, type JsonValue } from "@get-bb/plugin-sdk/app";
import { EmulatorPanel } from "./ui/EmulatorPanel";

function avdFrom(params: JsonValue | null): string | null {
  if (params && typeof params === "object" && !Array.isArray(params) && typeof params.avdId === "string") {
    return params.avdId;
  }
  return null;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "emulator",
    title: "Android Emulator",
    icon: "Smartphone",
    layout: "flush",
    component: ({ params }) => <EmulatorPanel initialAvdId={avdFrom(params)} />,
  });
  app.slots.experimental_newThreadPanelAction({
    id: "emulator-new-thread",
    title: "Android Emulator",
    icon: "Smartphone",
    layout: "flush",
    component: ({ params }) => <EmulatorPanel initialAvdId={avdFrom(params)} />,
  });
});
