import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyUrl, extractLinks, linearKeysFromBranch, storageAttachments } from "./attachments.ts";
import { isPublicHttpUrl, parseWebPreview } from "./enrich.ts";

test("classifies the services a thread links to", () => {
  const kinds = [
    "https://linear.app/acme/issue/ENG-123/fix-login",
    "https://www.notion.so/Project-Roadmap-0123456789abcdef0123456789abcdef",
    "https://github.com/acme/app/pull/149",
    "https://github.com/acme/app/issues/7",
    "https://www.figma.com/design/AbC123/Checkout-Redesign?node-id=1-2",
    "https://acme.slack.com/archives/C123/p456",
    "https://example.com/shot.png",
    "https://developer.android.com/guide",
  ].map((url) => classifyUrl(url).kind);
  assert.deepEqual(kinds, ["linear", "notion", "github", "github", "figma", "slack", "image", "web"]);
  const notion = classifyUrl("https://www.notion.so/Project-Roadmap-0123456789abcdef0123456789abcdef");
  assert.equal(notion.kind === "notion" && notion.pageId, "0123456789abcdef0123456789abcdef");
  assert.equal(notion.label, "Project Roadmap");
  assert.equal(classifyUrl("https://www.figma.com/design/AbC123/Checkout-Redesign").label, "Checkout Redesign");
});

test("collapses URLs that name the same thing and keeps newest first", () => {
  const refs = extractLinks(
    [
      "old https://linear.app/acme/issue/ENG-1/a-slug",
      "see https://github.com/acme/app/pull/149.",
      "logs http://localhost:3000/x and https://s3.amazonaws.com/a.apk?X-Amz-Signature=abc",
      '"text":"again https://linear.app/acme/issue/ENG-1/other-slug and https://github.com/acme/app/pull/149#issuecomment-1"',
    ],
    10,
  );
  assert.deepEqual(refs.map((ref) => ref.id), ["github:acme/app#149", "linear:ENG-1"]);
});

test("suggests Linear keys from branch names without version noise", () => {
  assert.deepEqual(linearKeysFromBranch("me/eng-123-fix-login"), ["ENG-123"]);
  assert.deepEqual(linearKeysFromBranch("octocat/checkout-v3-06-summary"), []);
  assert.deepEqual(linearKeysFromBranch("feature/ENG-42"), ["ENG-42"]);
  assert.deepEqual(linearKeysFromBranch(null), []);
});

test("splits thread storage into images and files", () => {
  const refs = storageAttachments([
    { name: "shot.PNG", path: "Attachments/shot.PNG" },
    { name: "report.md", path: "report.md" },
  ]);
  assert.deepEqual(refs.map((ref) => ref.kind), ["image", "file"]);
});

test("parses OpenGraph previews and resolves relative images", () => {
  const preview = parseWebPreview(
    `<html><head><title>Fallback</title>
      <meta property="og:title" content="Edge-to-edge &amp; insets">
      <meta content="Draw behind the bars." name="description">
      <meta property="og:image" content="/img/hero.png">
      <meta property="og:site_name" content="Android Developers"></head></html>`,
    "https://developer.android.com/develop/ui/views/layout/edge-to-edge",
  );
  assert.deepEqual(preview, {
    title: "Edge-to-edge & insets",
    description: "Draw behind the bars.",
    siteName: "Android Developers",
    imageUrl: "https://developer.android.com/img/hero.png",
  });
  assert.equal(parseWebPreview("<title>Only title</title>", "https://x.dev").title, "Only title");
  assert.equal(
    parseWebPreview('<meta property="og:title" content="Edge &nbsp;|&nbsp; Views &#x2014; Android&#39;s">', "https://x.dev").title,
    "Edge | Views — Android's",
  );
});

test("refuses local and private addresses", () => {
  assert.equal(isPublicHttpUrl("https://developer.android.com/x"), true);
  for (const url of ["http://localhost:8080", "http://127.0.0.1/x", "http://192.168.1.5", "http://10.0.0.1", "http://[::1]/", "file:///etc/hosts", "http://printer.local"]) {
    assert.equal(isPublicHttpUrl(url), false, url);
  }
});
