import assert from "node:assert/strict";
import { test } from "node:test";
import { sharePreview } from "../src/services/sharePreview";

test("the first heading is the title and the rest is the summary", () => {
  const preview = sharePreview("مقدمه‌ای کوتاه\n\n# راهنمای **نیم‌فاصله**\n\n- می‌روم و [کتاب‌ها](https://x.ir)\n> نقل قول");
  assert.equal(preview.title, "راهنمای نیم‌فاصله");
  assert.equal(preview.description, "مقدمه‌ای کوتاه می‌روم و کتاب‌ها نقل قول");
});

test("without a heading the first line is the title", () => {
  assert.deepEqual(sharePreview("سلام دنیا\nخط دوم"), { title: "سلام دنیا", description: "خط دوم" });
});

test("code blocks, table rules and horizontal rules are left out", () => {
  const preview = sharePreview("# عنوان\n```js\nconst x = 1;\n```\n| الف | ب |\n|---|---|\n| ۱ | ۲ |\n---\nپایان");
  assert.equal(preview.description, "الف ب ۱ ۲ پایان");
});

test("long text is cut at a word boundary with an ellipsis", () => {
  const preview = sharePreview("عنوان\n" + "واژه ".repeat(100));
  assert.ok(preview.description.length <= 200);
  assert.ok(preview.description.endsWith("واژه…"));
});
