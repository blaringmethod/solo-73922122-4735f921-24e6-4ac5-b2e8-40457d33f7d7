"use strict";
/*
 * 整页集成测试（jsdom + 桩 fetch）：加载真实 index.html / app.js /
 * editor.js / editor-core.js，用桩响应驱动“保存 -> 分析渲染 ->
 * 确认 -> 下载”流程，重点核对：
 * - 保存请求体里的正文保留 CR/LF/CRLF（不被 textarea 规范化吞掉）；
 * - 重开会话（GET 状态）时编辑器恢复原样文本；
 * - 落点预览按原样码点渲染，半 CRLF 标签带 nl-half 标记；
 * - 校验失败（400）时页面保留当前会话与既有下载入口。
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

const STATIC = path.join(__dirname, "..", "..", "app", "static");
const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");

const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
window.NLEditorCore = require(path.join(STATIC, "editor-core.js"));
// jsdom 不提供 CSS.escape（真实浏览器均支持），加最小 polyfill
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) {
  window.CSS.escape = (s) =>
    String(s).replace(/[^a-zA-Z0-9_\-]/g, (c) => "\\" + c);
}

const calls = [];
// jsdom 不提供 fetch/Response，给一个最小实现（app.js 只用到 ok/status/text()）
class FakeResponse {
  constructor(text, init = {}) {
    this._text = text;
    this.status = init.status || 200;
    this.ok = this.status >= 200 && this.status < 300;
  }
  async text() { return this._text; }
}
window.Response = FakeResponse;

function makeState(over = {}) {
  const original = "银行\r\n业务\n清单\r一";
  const revised = "银行\r\n业务\n清单\r二";
  return Object.assign({
    session_id: "abcdef0123456789",
    revision: 1,
    original,
    revised,
    labels: [
      { id: "L1", start: 0, end: 2 },
      { id: "L2", start: 2, end: 3 },
      { id: "L3", start: 10, end: 11 },
    ],
    analysis: {
      distance: 1,
      labels: [
        { id: "L1", start: 0, end: 2, text: "银行", status: "auto",
          possible: [0], preserved_in_all: true },
        { id: "L2", start: 2, end: 3, text: "\r", status: "auto",
          possible: [2], preserved_in_all: true },
        { id: "L3", start: 10, end: 11, text: "一", status: "impossible",
          possible: [], preserved_in_all: false },
      ],
    },
    selections: {},
    has_result: false,
    download_url: null,
  }, over);
}

window.fetch = async (url, options) => {
  calls.push({ url, options });
  const body = options && options.body ? JSON.parse(options.body) : null;
  const u = String(url);
  if (u.endsWith("/api/sessions") && options.method === "POST") {
    return new FakeResponse(JSON.stringify(makeState()), {
      status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/inputs")) {
    if (body && body.original && body.original.length > 120) {
      return new FakeResponse(JSON.stringify({ detail: "原文超长：121 个码点，上限 120" }),
        { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new FakeResponse(JSON.stringify(makeState({ revision: 2 })),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/selections")) {
    return new FakeResponse(JSON.stringify({ ok: true, revision: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/confirm")) {
    const st = makeState({
      has_result: true,
      download_url: "/api/sessions/abcdef0123456789/download",
    });
    st.result = {
      revised: st.revised,
      labels: [
        { id: "L1", start: 0, end: 2, text: "银行" },
        { id: "L2", start: 2, end: 3, text: "\r" },
      ],
      meta: { session_id: st.session_id, revision: 1, edit_distance: 1,
              migrated: 2, discarded: ["L3"] },
    };
    return new FakeResponse(JSON.stringify(st),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error("unexpected fetch " + u);
};

window.eval(fs.readFileSync(path.join(STATIC, "editor.js"), "utf8"));
// eval 环境下 UMD 走 module.exports 分支，直接 require 挂到 window
window.PreviewCore = require(path.join(STATIC, "preview-core.js"));
window.eval(fs.readFileSync(path.join(STATIC, "app.js"), "utf8"));

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok -", name); }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const $ = (id) => window.document.getElementById(id);

// 触发 DOMContentLoaded -> init()
window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

(async () => {

await test("init 后两个正文 textarea 被 NLEditor 接管", () => {
  assert.ok($("original").classList.contains("nl-textarea"));
  assert.ok($("revised").classList.contains("nl-textarea"));
  assert.strictEqual($("original").value, "");
});

await test("填入混合换行示例并保存：请求体原样携带 CR/LF/CRLF", async () => {
  const exOriginal = "银行\r\n业务\n清单\r一";
  const exRevised = "银行\r\n业务\n清单\r二";
  $("example-select").value = "4";
  $("load-example").click();
  // 通过 DOM 工具栏统计间接确认 raw 已载入
  const stats = window.document.querySelectorAll(".nl-stats");
  assert.ok(stats[0].textContent.includes("CRLF"));
  await $("save").click();
  await flush();
  const post = calls.find((c) => c.options.method === "POST");
  const payload = JSON.parse(post.options.body);
  assert.strictEqual(payload.original, exOriginal);
  assert.strictEqual(payload.revised, exRevised);
  assert.ok(payload.original.includes("\r\n") && payload.original.includes("\n")
    && payload.original.includes("\r"));
});

await test("保存成功后分析卡片按原样码点渲染，半 CRLF 标签带 nl-half", () => {
  const cards = window.document.querySelectorAll(".label-card");
  assert.strictEqual(cards.length, 3);
  const l2 = window.document.getElementById("card-L2");
  // 原文预览与落点预览各一个半 CRLF 徽章
  const half = l2.querySelectorAll(".nl-crlf.nl-half");
  assert.strictEqual(half.length, 2);
  for (const mark of half) {
    // 每个徽章里只高亮 CR（第一个码点），LF 不高亮
    const marks = mark.querySelectorAll("mark");
    assert.strictEqual(marks.length, 1);
    assert.strictEqual(marks[0].textContent, "␍");
  }
});

await test("落点预览里 CRLF 徽章与位置标签都在", () => {
  const l1 = window.document.getElementById("card-L1");
  assert.ok(l1.querySelector("mark").textContent.includes("银") ||
            l1.querySelector("mark").textContent === "银行");
  const posTags = l1.querySelectorAll(".pos-tag");
  assert.ok(posTags[0].textContent.includes("[0, 2)"));
});

await test("只改标签名再次保存：正文 raw 未被触碰，CR 仍在请求体里", async () => {
  const labelsArea = $("labels");
  const labels = JSON.parse(labelsArea.value);
  labels.labels[0].id = "renamed";
  labelsArea.value = JSON.stringify(labels);
  await $("save").click();
  await flush();
  const put = calls.filter((c) => c.options.method === "PUT").pop();
  const payload = JSON.parse(put.options.body);
  assert.strictEqual(payload.original, "银行\r\n业务\n清单\r一");
  assert.strictEqual(payload.revised, "银行\r\n业务\n清单\r二");
  assert.strictEqual(payload.labels.labels[0].id, "renamed");
});

await test("确认成功后出现下载入口，结果预览保留 CRLF", async () => {
  await $("confirm").click();
  await flush();   // selections PUT
  await flush();   // confirm POST
  const dl = $("download");
  assert.ok(!dl.classList.contains("hidden"),
    "download still hidden; confirm-status=" + $("confirm-status").textContent +
    " banner=" + $("banner").textContent);
  assert.ok(dl.href.includes("/download"));
  const preview = $("result-preview").textContent;
  const parsed = JSON.parse(preview);
  assert.strictEqual(parsed.revised, "银行\r\n业务\n清单\r二");
  const l2 = parsed.labels.find((l) => l.id === "L2");
  assert.deepStrictEqual([l2.start, l2.end, l2.text], [2, 3, "\r"]);
});

await test("超长保存被 400 拒绝：会话版本与下载入口都保留", async () => {
  // 直接通过编辑器灌入超长 raw
  const ed = window.origEditor;
  assert.ok(ed, "origEditor 暴露在 window");
  ed.setRaw("x".repeat(121));
  await $("save").click();
  await flush();
  const banner = $("banner");
  assert.ok(banner.classList.contains("error"));
  assert.ok(banner.textContent.includes("超长"));
  // state 未被失败响应覆盖：下载入口仍在、版本号停留在 r2
  assert.ok($("revision-info").textContent.includes("r2"));
  assert.ok(!$("download").classList.contains("hidden"));
});

console.log(`\n${passed} page integration tests passed`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
