import assert from "node:assert/strict";
import { test } from "node:test";
import { isWidgetScriptName, parseScriptMeta, parseWidgetOutput, widgetNameFromFile } from "./widgets.ts";

test("reads bb-widget settings from any comment style", () => {
  const meta = parseScriptMeta("#!/bin/sh\n# bb-widget: title=Devices\n// bb-widget: size=wide\n# bb-widget: refresh=2\n# bb-widget: scope=global\n");
  assert.deepEqual(meta, { title: "Devices", size: "wide", refreshSeconds: 5, scope: "global" });
  assert.deepEqual(parseScriptMeta("echo hi"), { title: null, size: null, refreshSeconds: 60, scope: "thread" });
  assert.equal(parseScriptMeta("# bb-widget: size=huge").size, null);
});

test("accepts one widget or a list, and explains bad output", () => {
  const one = parseWidgetOutput('{"title":"CI","value":"Green","tone":"positive","progress":1}');
  assert.equal(one.ok && one.widgets[0]?.value, "Green");
  const many = parseWidgetOutput('{"widgets":[{"title":"A"},{"title":"B"}]}');
  assert.equal(many.ok && many.widgets.length, 2);
  assert.deepEqual(parseWidgetOutput("not json"), { ok: false, error: "The script did not print JSON." });
  const bad = parseWidgetOutput('{"title":"X","tone":"purple"}');
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : "", /tone/u);
  const unsafe = parseWidgetOutput('{"title":"X","url":"javascript:alert(1)"}');
  assert.equal(unsafe.ok, false);
});

test("picks widget scripts out of a folder", () => {
  assert.equal(isWidgetScriptName("android-devices.sh"), true);
  assert.equal(isWidgetScriptName(".hidden"), false);
  assert.equal(isWidgetScriptName("README.md"), false);
  assert.equal(isWidgetScriptName("ci.py~"), false);
  assert.equal(widgetNameFromFile("android-devices.sh"), "android-devices");
});
