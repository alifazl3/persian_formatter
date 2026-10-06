import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const context = createContext({});
runInContext(readFileSync(resolve(__dirname, "../../virastar.js"), "utf8"), context);
const clean = (text: string) => runInContext(`persianCleanup(${JSON.stringify(text)})`, context) as { text: string; changes: Record<string, number>; total: number };
const Z = "‌";

test("Arabic letters and digits become Persian", () => {
  assert.equal(clean("علي يك كتاب ٣ دارد").text, "علی یک کتاب ۳ دارد");
});

test("half-spaces after می/نمی and before plural and comparative suffixes", () => {
  assert.equal(clean("ما می رویم و نمی دانیم").text, `ما می${Z}رویم و نمی${Z}دانیم`);
  assert.equal(clean("کتاب ها و بزرگ تر و بهترین ترین").text, `کتاب${Z}ها و بزرگ${Z}تر و بهترین${Z}ترین`);
  assert.equal(clean("کمی بیشتر").text, "کمی بیشتر", "می inside a word is not a prefix");
});

test("punctuation spacing and Latin punctuation between Persian words", () => {
  assert.equal(clean("سلام , خوبی ?").text, "سلام، خوبی؟");
  assert.equal(clean("تمام شد .").text, "تمام شد.");
  assert.equal(clean("اول،دوم؛سوم").text, "اول، دوم؛ سوم");
});

test("code, inline code, math and links are untouched", () => {
  const code = "```\nvar ي = 'می رود'\n```";
  assert.equal(clean(code).text, code);
  assert.equal(clean("دستور `ls -la , ?` را بزن").text, "دستور `ls -la , ?` را بزن");
  assert.equal(clean("فرمول $a , b$ و لینک https://x.ir/می رود").text, "فرمول $a , b$ و لینک https://x.ir/می رود");
});

test("Latin text is never changed", () => {
  const latin = "Hello , world ? I am  here. version 2.1, ok";
  assert.equal(clean(latin).text, latin);
  assert.equal(clean(latin).total, 0);
});

test("changes are counted by kind and clean text is stable", () => {
  const result = clean("علي می رود , کتاب ها");
  assert.equal(result.changes.arabic, 1);
  assert.equal(result.changes.zwnj, 2);
  assert.equal(result.changes.punctuation, 1);
  assert.equal(clean(result.text).total, 0, "running twice changes nothing more");
});
