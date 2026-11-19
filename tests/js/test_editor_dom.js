"use strict";
/*
 * 编辑器 DOM 集成测试（jsdom）：验证 textarea 规范化与 raw 同步、
 * 徽章渲染/点击切换、工具栏转换、粘贴、setRaw/getRaw、码点统计展示。
 * 运行：node tests/js/test_editor_dom.js（jsdom 安装在 /tmp/jstest）
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  console.error("缺少 jsdom 依赖，请先在项目根目录执行：npm install");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.CSS = dom.window.CSS;
global.getComputedStyle = dom.window.getComputedStyle;

const STATIC = path.join(__dirname, "..", "..", "app", "static");
// 浏览器里 self === window，UMD 挂到 window；Node 下走 module.exports，手动挂回
window.NLEditorCore = require(path.join(STATIC, "editor-core.js"));
window.eval(fs.readFileSync(path.join(STATIC, "editor.js"), "utf8"));
const C = window.NLEditorCore;
const NLEditor = window.NLEditor;
assert.ok(C && NLEditor, "editor globals missing");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function makeEditor(initial) {
  const ta = document.createElement("textarea");
  // 页面通过 data-raw 传入初始原样文本（textarea 赋值会被浏览器规范化）
  ta.dataset.nlRaw = initial;
  ta.value = initial;
  document.body.appendChild(ta);
  return new NLEditor(ta);
}

test("构造后 textarea 值是 LF 规范化结果，raw 保留原样", () => {
  const ed = makeEditor("a\r\nb\rc\nd");
  assert.strictEqual(ed.getRaw(), "a\r\nb\rc\nd");
  assert.strictEqual(ed.ta.value, "a\nb\nc\nd");
});

test("backdrop 渲染三类徽章并带 normi 数据", () => {
  const ed = makeEditor("a\r\nb\rc\nd");
  const marks = ed.backdrop.querySelectorAll(".nl-mark");
  assert.strictEqual(marks.length, 3);
  assert.deepStrictEqual(
    Array.from(marks).map((m) => m.className.replace("nl-mark ", "")),
    ["nl-crlf", "nl-cr", "nl-lf"]);
  assert.deepStrictEqual(
    Array.from(marks).map((m) => Number(m.dataset.normi)), [1, 3, 5]);
});

test("点击徽章循环切换 CR -> LF -> CRLF -> CR，textarea 值不变", () => {
  const ed = makeEditor("a\r\nb");
  const mark = () => ed.backdrop.querySelector(".nl-mark");
  assert.ok(mark().classList.contains("nl-crlf"));
  mark().click();                                   // crlf -> cr
  assert.ok(mark().classList.contains("nl-cr"));
  assert.strictEqual(ed.getRaw(), "a\rb");
  mark().click();                                   // cr -> lf
  assert.strictEqual(ed.getRaw(), "a\nb");
  mark().click();                                   // lf -> crlf
  assert.strictEqual(ed.getRaw(), "a\r\nb");
  assert.strictEqual(ed.ta.value, "a\nb");          // norm 全程不变
});

test("工具栏按钮把光标处换行转换为指定类型", () => {
  const ed = makeEditor("a\r\nb");
  ed.ta.setSelectionRange(2, 2);                    // 光标在换行之后
  ed.toolbar.querySelector('button[data-nl="lf"]').click();
  assert.strictEqual(ed.getRaw(), "a\nb");
  ed.toolbar.querySelector('button[data-nl="cr"]').click();
  assert.strictEqual(ed.getRaw(), "a\rb");
  ed.toolbar.querySelector('button[data-nl="crlf"]').click();
  assert.strictEqual(ed.getRaw(), "a\r\nb");
});

test("工具栏对选区内多个换行批量转换", () => {
  const ed = makeEditor("a\nb\nc");
  // norm 选中覆盖两个换行（码点区间 [1,4)：\n b \n）
  ed.ta.setSelectionRange(1, 4);
  ed.toolbar.querySelector('button[data-nl="crlf"]').click();
  assert.strictEqual(ed.getRaw(), "a\r\nb\r\nc");
});

test("模拟打字改一个普通字：未编辑字符与所有换行形式保留", () => {
  const ed = makeEditor("头\r\n中\r尾\n末");
  // jsdom 里直接改 value 再派发 input，等价于用户编辑
  ed.ta.value = ed.ta.value.replace("尾", "首");
  ed.ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.strictEqual(ed.getRaw(), "头\r\n中\r首\n末");
});

test("模拟在 textarea 里按回车：新增 LF，原有 CRLF 不动", () => {
  const ed = makeEditor("a\r\nb");
  ed.ta.value = "a\n\nb";
  ed.ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.strictEqual(ed.getRaw(), "a\n\r\nb");
});

test("模拟删除换行：CRLF 两个码点一起消失", () => {
  const ed = makeEditor("a\r\nb");
  ed.ta.value = "ab";
  ed.ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.strictEqual(ed.getRaw(), "ab");
});

test("粘贴事件：粘贴文本被插入且其换行形式保留（浏览器给的是 LF 文本）", () => {
  const ed = makeEditor("ab\r\ncd");
  ed.ta.setSelectionRange(1, 1);
  const dt = { getData: () => "x\ny" };   // jsdom 无 DataTransfer，用桩对象
  const ev = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: dt });
  ed.ta.dispatchEvent(ev);
  assert.strictEqual(ed.getRaw(), "ax\nyb\r\ncd");
});

test("setRaw 重新载入服务端原样文本（重开会话场景），CR 不丢", () => {
  const ed = makeEditor("");
  const raw = "银行\r\n业务\n清单\r一";
  ed.setRaw(raw);
  assert.strictEqual(ed.getRaw(), raw);
  assert.strictEqual(ed.ta.value, "银行\n业务\n清单\n一");
  // 再保存（未编辑）应得到完全相同的 raw
  assert.strictEqual(C.applyNormEdit(ed.getRaw(), ed.ta.value), raw);
});

test("码点统计与超限高亮", () => {
  const ed = makeEditor("a\r\nb");              // a CR LF b = 4 码点
  const statsEl = ed.toolbar.querySelector(".nl-stats");
  assert.ok(statsEl.textContent.includes("4 / 120 码点"));
  assert.ok(statsEl.textContent.includes("CRLF ×1"));
  assert.ok(!statsEl.classList.contains("nl-over"));
  ed.setRaw("x".repeat(121));
  assert.ok(statsEl.classList.contains("nl-over"));
  assert.ok(statsEl.textContent.startsWith("121 / 120"));
});

test("选区 raw 区间显示：光标在 CRLF 前后给出不同 raw 码点", () => {
  const ed = makeEditor("ab\r\ncd");
  const el = ed.toolbar.querySelector(".nl-selrange");
  ed.ta.setSelectionRange(2, 2);     // 换行前
  ed.ta.dispatchEvent(new window.Event("select", { bubbles: true }));
  assert.ok(el.textContent.includes("2"));
  ed.ta.setSelectionRange(3, 3);     // 换行后（norm 下标 3）
  ed.ta.dispatchEvent(new window.Event("select", { bubbles: true }));
  assert.ok(el.textContent.includes("4"));
});

test("emoji 代理对不打乱光标与 raw 同步", () => {
  const ed = makeEditor("😀\r\n😃");
  assert.strictEqual(ed.ta.value, "😀\n😃");
  ed.ta.value = "😜\n😃";
  ed.ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  // 换行在 LCS 中是未编辑的相等元素：CRLF 原样保留，只换了 emoji
  assert.strictEqual(ed.getRaw(), "😜\r\n😃");
});

console.log(`\n${passed} DOM tests passed`);
