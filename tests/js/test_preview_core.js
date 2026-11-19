"use strict";
/*
 * 落点预览渲染的纯逻辑测试（无 DOM）：node tests/js/test_preview_core.js
 * 重点：按原样码点定位、半 CRLF 高亮区分 CR 与 LF、三类换行徽章。
 */
const assert = require("assert");
const path = require("path");
const P = require(path.join(__dirname, "..", "..", "app", "static", "preview-core.js"));
const { tokenPreview } = P;

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("普通字符按区间高亮", () => {
  assert.strictEqual(tokenPreview("abcde", 1, 3),
    "a<mark>b</mark><mark>c</mark>de");
});

test("空区间不产生高亮", () => {
  assert.strictEqual(tokenPreview("ab", 1, 1), "ab");
});

test("CRLF 整体被覆盖：徽章高亮两半，不加 nl-half", () => {
  const html = tokenPreview("a\r\nb", 1, 3);
  assert.ok(html.includes('class="nl-mark nl-crlf"'));
  assert.ok(!html.includes("nl-half"));
  assert.strictEqual(
    (html.match(/<mark>/g) || []).length, 2);   // CR、LF 都高亮
});

test("只覆盖 CRLF 的 CR 一半：nl-half 且仅 CR 高亮", () => {
  const html = tokenPreview("a\r\nb", 1, 2);
  assert.ok(html.includes('class="nl-mark nl-crlf nl-half"'));
  const marks = html.match(/<mark>[^<]*<\/mark>/g);
  assert.deepStrictEqual(marks, ["<mark>␍</mark>"]);
  assert.ok(html.includes("␊") && !/<mark>␊<\/mark>/.test(html));
  assert.ok(html.includes("标签覆盖 CR"));
});

test("只覆盖 CRLF 的 LF 一半：nl-half 且仅 LF 高亮", () => {
  const html = tokenPreview("a\r\nb", 2, 3);
  assert.ok(html.includes('class="nl-mark nl-crlf nl-half"'));
  const marks = html.match(/<mark>[^<]*<\/mark>/g);
  assert.deepStrictEqual(marks, ["<mark>␊</mark>"]);
  assert.ok(html.includes("标签覆盖 LF"));
});

test("单独 CR 与 LF 徽章各自渲染；被覆盖的单个换行只高亮、不加 nl-half", () => {
  const html = tokenPreview("a\rb\nc", 1, 2);   // 只高亮 CR
  assert.ok(html.includes('class="nl-mark nl-cr"'));
  assert.ok(!html.includes("nl-half"));
  assert.ok(html.includes('class="nl-mark nl-lf"'));
  assert.deepStrictEqual(html.match(/<mark>[^<]*<\/mark>/g), ["<mark>␍</mark>"]);
});

test("混合文本：CRLF + LF + CR 三种徽章同时出现", () => {
  const html = tokenPreview("银行\r\n业务\n清单\r一", 0, 11);
  assert.ok(html.includes("nl-crlf") && html.includes("nl-lf") && html.includes("nl-cr"));
  // 全区间覆盖：CRLF 两半都高亮，但不算“半覆盖”
  assert.ok(!html.includes("nl-half"));
});

test("HTML 特殊字符被转义，不破坏结构", () => {
  const html = tokenPreview("<b>&\"'", 0, 1);
  assert.ok(html.startsWith("<mark>&lt;</mark>"));
  assert.ok(html.includes("&amp;") && html.includes("&quot;") && html.includes("&#39;"));
});

test("emoji 按单码点处理，区间不被代理对打乱", () => {
  // 😀(0) \r(1) \n(2) 😃(3)
  const html = tokenPreview("😀\r\n😃", 0, 1);
  assert.strictEqual(html.indexOf("<mark>😀</mark>"), 0);
  assert.ok(html.includes("nl-crlf") && !html.includes("nl-half"));
});

console.log(`\n${passed} tests passed`);
