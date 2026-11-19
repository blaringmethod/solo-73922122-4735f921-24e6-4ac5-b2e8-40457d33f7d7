"use strict";
/*
 * 编辑器纯逻辑测试（无 DOM）：node tests/js/test_editor_core.js
 * 覆盖：换行规范化与双向映射、普通编辑/回车/删除/粘贴对 raw 的影响、
 * 未编辑字符与换行形式原样保留、半 CRLF 选区换算、码点统计。
 */
const assert = require("assert");
const path = require("path");
const C = require(path.join(__dirname, "..", "..", "app", "static", "editor-core.js"));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ok -", name);
}

/* ---------- normalize / buildNorm 映射 ---------- */

test("normalizeNL 把 CR 与 CRLF 规范化成 LF，普通 LF 不变", () => {
  assert.strictEqual(C.normalizeNL("a\rb"), "a\nb");
  assert.strictEqual(C.normalizeNL("a\r\nb"), "a\nb");
  assert.strictEqual(C.normalizeNL("a\nb"), "a\nb");
  assert.strictEqual(C.normalizeNL("\r\r\n\n"), "\n\n\n");
});

test("buildNorm 的 n2r：CRLF 在 norm 只占一个 LF，映射到 CR 起点", () => {
  const raw = "ab\r\nc";          // 码点 a b \r \n c
  const { norm, n2r, r2n } = C.buildNorm(raw);
  assert.strictEqual(norm, "ab\nc");
  assert.deepStrictEqual(n2r, [0, 1, 2, 4]);        // norm 的 \n -> raw[2](\r)
  assert.deepStrictEqual(r2n, [0, 1, 2, 2, 3]);     // raw \r,\n 都 -> norm 2
});

test("buildNorm 处理单独 CR、末尾 CRLF 与空串", () => {
  // raw 码点：x(0) \r(1) y(2) \r(3) \n(4)；norm：x \n y \n
  const { norm, n2r } = C.buildNorm("x\ry\r\n");
  assert.strictEqual(norm, "x\ny\n");
  assert.deepStrictEqual(n2r, [0, 1, 2, 3]);
  assert.deepStrictEqual(C.buildNorm("").n2r, []);
});

test("classify 区分 crlf / cr / lf 三类换行组", () => {
  const groups = C.classify("a\r\nb\rc\nd");
  assert.deepStrictEqual(groups.map((g) => g.type), ["crlf", "cr", "lf"]);
  assert.deepStrictEqual(groups.map((g) => g.normI), [1, 3, 5]);
  assert.deepStrictEqual(groups.map((g) => [g.rawI, g.end]), [[1, 3], [4, 5], [6, 7]]);
});

/* ---------- 普通编辑：未编辑字符与换行形式原样保留 ---------- */

test("在普通字符中插入一个字，CR/LF/CRLF 全部原样保留", () => {
  const raw = "a\r\nb\rc\nd";
  // 在 norm 末尾加 "X"（textarea 打字）
  const next = C.applyNormEdit(raw, C.normalizeNL(raw) + "X");
  assert.strictEqual(next, "a\r\nb\rc\ndX");
});

test("改中间一个字，未编辑的字符与换行形式一个都不变", () => {
  const raw = "头\r\n中\r尾\n末";
  const norm = C.normalizeNL(raw);          // 头\n中\n尾\n末
  const next = C.applyNormEdit(raw, norm.replace("尾", "首"));
  assert.strictEqual(next, "头\r\n中\r首\n末");
});

test("只在另一侧编辑时这一侧文本的换行形式不动（由调用方各自保存保证）", () => {
  // 单个编辑器实例的 raw 只在它自己被编辑时变化
  const raw = "甲\r\n乙";
  const next = C.applyNormEdit(raw, C.normalizeNL(raw));   // 无实际改动
  assert.strictEqual(next, raw);
});

test("回车产生的新换行是 LF，原有 CRLF/CR 不受影响", () => {
  const raw = "a\r\nb";
  const norm = C.normalizeNL(raw);          // a\nb
  // 在 a 与换行之间回车：norm -> "a\n\nb"
  const next = C.applyNormEdit(raw, "a\n\nb");
  assert.strictEqual(next, "a\n\r\nb");     // 新 LF + 原 CRLF 原样
});

test("删除 norm 的 LF 会连同整个 CRLF（两个码点）一起删", () => {
  const raw = "a\r\nb";
  const next = C.applyNormEdit(raw, "ab");
  assert.strictEqual(next, "ab");
});

test("删除单独 CR 换行组", () => {
  const raw = "a\rb";
  assert.strictEqual(C.applyNormEdit(raw, "ab"), "ab");
});

test("删除换行一侧的普通字符不碰换行组", () => {
  const raw = "a\r\nb";
  // 删掉 b：norm "a\nb" -> "a\n"
  assert.strictEqual(C.applyNormEdit(raw, "a\n"), "a\r\n");
});

test("粘贴混合换行文本：spliceRaw 原样保留粘贴内容的 CR/LF/CRLF", () => {
  const raw = "ab\r\ncd";
  // 在 norm 位置 1（a 与 b 之间）插入 "x\ry\r\nz\nw"
  const insert = "x\ry\r\nz\nw";
  const next = C.spliceRaw(raw, 1, 1, insert);
  assert.strictEqual(next, "ax\ry\r\nz\nwb\r\ncd");
});

test("spliceRaw 删除选区覆盖整个 CRLF 时两个码点都消失", () => {
  const raw = "a\r\nb";
  // norm 里选中换行（index 1）
  assert.strictEqual(C.spliceRaw(raw, 1, 2, ""), "ab");
});

test("spliceRaw 的插入位置可落在 CRLF 之前或之后", () => {
  const raw = "a\r\nb";
  // 插在换行组之前（norm index 1）
  assert.strictEqual(C.spliceRaw(raw, 1, 1, "X"), "aX\r\nb");
  // 插在换行组之后（norm index 2）
  assert.strictEqual(C.spliceRaw(raw, 2, 2, "Y"), "a\r\nYb");
});

/* ---------- 换行类型转换 ---------- */

test("convertNewline 在三种类型间切换且 norm 不变", () => {
  const raw = "a\r\nb";
  const g = C.classify(raw)[0];
  const lf = C.convertNewline(raw, g, "lf");
  assert.strictEqual(lf, "a\nb");
  const cr = C.convertNewline(lf, C.classify(lf)[0], "cr");
  assert.strictEqual(cr, "a\rb");
  const back = C.convertNewline(cr, C.classify(cr)[0], "crlf");
  assert.strictEqual(back, "a\r\nb");
  assert.strictEqual(C.normalizeNL(lf), C.normalizeNL(cr));
  assert.strictEqual(C.normalizeNL(back), C.normalizeNL(raw));
});

/* ---------- 选区/码点定位（标签校验与高亮按原样文本） ---------- */

test("selectionToRaw：只覆盖 CRLF 一半时给出精确的单码点区间", () => {
  const raw = "ab\r\ncd";                   // raw 码点 0a 1b 2CR 3LF 4c 5d
  // norm: a b \n c d，下标 0 1 2  3 4
  // norm 选区 [2,3) 是那个合并的换行：整体区间应包含 CR+LF
  assert.deepStrictEqual(C.selectionToRaw(raw, 2, 3), { start: 2, end: 4 });
  // 光标在换行前
  assert.deepStrictEqual(C.selectionToRaw(raw, 2, 2), { start: 2, end: 2 });
  // 光标在换行后 -> raw 4
  assert.deepStrictEqual(C.selectionToRaw(raw, 3, 3), { start: 4, end: 4 });
});

test("selectionToRaw：普通字符选区与末尾光标", () => {
  const raw = "a\rb";
  assert.deepStrictEqual(C.selectionToRaw(raw, 0, 1), { start: 0, end: 1 });
  assert.deepStrictEqual(C.selectionToRaw(raw, 3, 3), { start: 3, end: 3 });
});

/* ---------- 统计 ---------- */

test("stats 按码点计数并分别统计三类换行", () => {
  // a CR LF b CR c LF d = 8 码点
  assert.deepStrictEqual(C.stats("a\r\nb\rc\nd"),
    { cp: 8, cr: 1, lf: 1, crlf: 1 });
  assert.deepStrictEqual(C.stats(""), { cp: 0, cr: 0, lf: 0, crlf: 0 });
});

test("stats 把代理对 emoji 计为一个码点", () => {
  assert.strictEqual(C.stats("😀\r\n😃").cp, 4);   // emoji CR LF emoji
});

/* ---------- 端到端式组合场景 ---------- */

test("综合：混用文本多次局部编辑后，未编辑部分与换行形式始终保留", () => {
  let raw = "银行\r\n业务\n清单\r一";
  // 1) 末尾“一”改成“二”
  let norm = C.normalizeNL(raw);
  raw = C.applyNormEdit(raw, norm.replace("一", "二"));
  assert.strictEqual(raw, "银行\r\n业务\n清单\r二");
  // 2) 在“业务”后加一个字
  norm = C.normalizeNL(raw);
  raw = C.applyNormEdit(raw, norm.replace("业务\n", "业务X\n"));
  assert.strictEqual(raw, "银行\r\n业务X\n清单\r二");
  // 3) 删掉 CRLF 前的“行”，CRLF 仍在
  norm = C.normalizeNL(raw);
  raw = C.applyNormEdit(raw, norm.replace("银行", "银"));
  assert.strictEqual(raw, "银\r\n业务X\n清单\r二");
  // 4) 把中间的 LF 转成 CRLF
  const g = C.classify(raw).find((x) => x.type === "lf");
  raw = C.convertNewline(raw, g, "crlf");
  assert.strictEqual(raw, "银\r\n业务X\r\n清单\r二");
  // 5) 粘贴一段带 CR 的文本到开头
  raw = C.spliceRaw(raw, 0, 0, "Z\r");
  assert.strictEqual(raw, "Z\r银\r\n业务X\r\n清单\r二");
});

console.log(`\n${passed} tests passed`);
