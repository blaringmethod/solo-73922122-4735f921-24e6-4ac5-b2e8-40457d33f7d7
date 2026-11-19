"use strict";

/* ---------- 内置示例（与 examples/ 目录一致） ---------- */
const EXAMPLES = [
  {
    name: "01 自动迁移（唯一落点）",
    original: "语料工程师修订OCR文本",
    revised: "语料工程师修订OCR文本内容",
    labels: { labels: [{ id: "role", start: 0, end: 5 }, { id: "task", start: 7, end: 10 }] }
  },
  {
    name: "02 重复文字 · 多落点需选择",
    original: "abcabcabc",
    revised: "abcabc",
    labels: { labels: [{ id: "rep", start: 3, end: 6 }] }
  },
  {
    name: "03 无法保留（字符被替换）",
    original: "中国人民银行",
    revised: "中国人民银号",
    labels: { labels: [{ id: "bank", start: 4, end: 6 }] }
  },
  {
    name: "04 重复文字 · 双标签互相冲突",
    original: "abab",
    revised: "ab",
    labels: { labels: [{ id: "x", start: 0, end: 2 }, { id: "y", start: 2, end: 4 }] }
  },
  {
    // CR / LF / CRLF 混用；标签 L2 只覆盖 CRLF 的一半（CR 码点）
    name: "05 混合换行 CR/LF/CRLF（含半 CRLF 标签）",
    original: "银行\r\n业务\n清单\r一",
    revised: "银行\r\n业务\n清单\r二",
    labels: { labels: [
      { id: "L1", start: 0, end: 2 },
      { id: "L2", start: 2, end: 3 },
      { id: "L3", start: 10, end: 11 }
    ] }
  }
];

/* ---------- 全局状态 ---------- */
const state = {
  sessionId: null,
  revision: 0,
  analysis: null,
  selections: {},   // label_id -> {choice:'position',position} | {choice:'discard'}
  confirmed: false,
  original: "",     // 服务端回传的原样原文（预览按它的码点定位，不读 textarea）
  revised: "",
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let origEditor = null;
let revEditor = null;

/* ---------- 提示条 ---------- */
function showBanner(msg, isError = false) {
  const b = $("banner");
  b.textContent = msg;
  b.className = "banner" + (isError ? " error" : "");
}
function hideBanner() { $("banner").className = "banner hidden"; }

/* ---------- API ---------- */
async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (!resp.ok) {
    const err = new Error("HTTP " + resp.status);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

function detailMessage(data) {
  if (!data || data.detail == null) return "未知错误";
  if (typeof data.detail === "string") return data.detail;
  if (data.detail.message) return data.detail.message;
  return JSON.stringify(data.detail, null, 2);
}

/* ---------- 输入区 ---------- */
function updateCounts() {
  // 两个正文编辑器的码点统计由各自工具栏显示（按待保存的原样文本）。
  let msg = "";
  try {
    const v = JSON.parse($("labels").value);
    const arr = Array.isArray(v) ? v : v.labels;
    msg = Array.isArray(arr) ? arr.length + " / 10 个标签" : "";
  } catch { msg = "JSON 尚未解析成功"; }
  $("labels-count").textContent = msg;
}

function fillExample(i) {
  const ex = EXAMPLES[i];
  origEditor.setRaw(ex.original);
  revEditor.setRaw(ex.revised);
  $("labels").value = JSON.stringify(ex.labels, null, 2);
  updateCounts();
}

async function saveInputs() {
  hideBanner();
  let labels;
  try { labels = JSON.parse($("labels").value || "[]"); }
  catch (e) { showBanner("标签 JSON 解析失败：" + e.message, true); return; }
  // 直接取编辑器维护的原样文本，CR/LF/CRLF 与每个未编辑码点都不经过 textarea 规范化
  const body = JSON.stringify({
    original: origEditor.getRaw(),
    revised: revEditor.getRaw(),
    labels,
  });
  $("save-status").textContent = "保存中…";
  try {
    let st;
    if (!state.sessionId) {
      st = await api("/api/sessions", { method: "POST", body });
      state.sessionId = st.session_id;
      history.replaceState(null, "", "?session=" + st.session_id);
    } else {
      st = await api(`/api/sessions/${state.sessionId}/inputs`, { method: "PUT", body });
    }
    $("save-status").textContent = "已保存";
    applyState(st, /*fromServer=*/true);
  } catch (e) {
    $("save-status").textContent = "";
    showBanner("保存失败：" + detailMessage(e.data), true);
  }
}

/* ---------- 渲染：按原样码点渲染文本，换行码点可见、半 CRLF 可辨 ---------- */
const tokenPreview = window.PreviewCore.tokenPreview;

function renderAnalysis() {
  const box = $("label-cards");
  box.innerHTML = "";
  const a = state.analysis;
  if (!a) {
    $("analysis-summary").textContent = "尚未分析。";
    $("confirm").disabled = true;
    return;
  }
  $("analysis-summary").textContent =
    `最小编辑距离 ${a.distance}；标签 ${a.labels.length} 个：` +
    `自动迁移 ${a.labels.filter(l => l.status === "auto").length}，` +
    `待选择 ${a.labels.filter(l => l.status === "choice").length}，` +
    `无法保留 ${a.labels.filter(l => l.status === "impossible").length}。`;

  // 预览与高亮一律按服务端原样文本（raw 码点）定位，不读 textarea 的规范化值
  const original = state.original;
  const revised = state.revised;
  for (const lab of a.labels) {
    const card = document.createElement("div");
    card.className = "label-card";
    card.id = "card-" + lab.id;
    const L = lab.end - lab.start;
    const badgeText = { auto: "自动迁移", choice: "待选择", impossible: "无法保留" }[lab.status];
    let html = `<div class="label-head">
      <span class="lid">${esc(lab.id)}</span>
      <span class="span">原文 [${lab.start}, ${lab.end})</span>
      <pre class="nl-preview src-text">${tokenPreview(original, lab.start, lab.end)}</pre>
      <span class="badge ${lab.status}">${badgeText}</span>
    </div>`;

    if (lab.status === "auto") {
      const p = lab.possible[0];
      html += `<div class="choices">
        <label class="choice-item">
          <input type="radio" name="sel-${esc(lab.id)}" value="keep" checked>
          <span class="pos-tag">迁至 [${p}, ${p + L})</span>
          <pre class="nl-preview">${tokenPreview(revised, p, p + L)}</pre>
        </label>
        <label class="choice-item">
          <input type="radio" name="sel-${esc(lab.id)}" value="discard">
          <span class="pos-tag">丢弃该标签</span>
        </label>
      </div>`;
    } else if (lab.status === "choice") {
      if (lab.possible.length === 1 && !lab.preserved_in_all) {
        html += `<div class="hint">只有一个可能落点，但并非所有最优对齐都保留该标签，请确认是否迁移。</div>`;
      }
      html += `<div class="choices">` + lab.possible.map((p) => `
        <label class="choice-item">
          <input type="radio" name="sel-${esc(lab.id)}" value="${p}">
          <span class="pos-tag">迁至 [${p}, ${p + L})</span>
          <pre class="nl-preview">${tokenPreview(revised, p, p + L)}</pre>
        </label>`).join("") + `
        <label class="choice-item">
          <input type="radio" name="sel-${esc(lab.id)}" value="discard">
          <span class="pos-tag">丢弃该标签</span>
        </label>
      </div>`;
    } else {
      html += `<div class="impossible-note">原跨度字符未在任何最优对齐中完整连续保留，确认时将自动丢弃。</div>`;
    }
    card.innerHTML = html;
    box.appendChild(card);
  }

  // 恢复已保存的选择
  for (const [lid, sel] of Object.entries(state.selections)) {
    const name = "sel-" + lid;
    const value = sel.choice === "discard" ? "discard" : String(sel.position);
    const radio = document.querySelector(`input[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`);
    if (radio) radio.checked = true;
  }
  $("confirm").disabled = false;
}

function collectSelections() {
  const out = {};
  if (!state.analysis) return out;
  for (const lab of state.analysis.labels) {
    if (lab.status === "impossible") continue;
    const checked = document.querySelector(`input[name="sel-${CSS.escape(lab.id)}"]:checked`);
    if (!checked) continue;
    if (checked.value === "discard") out[lab.id] = { choice: "discard" };
    else if (checked.value === "keep") continue; // auto 默认迁移，无需记录
    else out[lab.id] = { choice: "position", position: Number(checked.value) };
  }
  return out;
}

/* ---------- 状态应用 ---------- */
function applyState(st, fromServer) {
  state.revision = st.revision;
  state.analysis = st.analysis;
  state.selections = st.selections || {};
  state.confirmed = st.has_result;
  state.original = st.original;
  state.revised = st.revised;
  $("session-info").textContent = "会话 " + st.session_id.slice(0, 8) + "…";
  $("revision-info").textContent = "版本 r" + st.revision;
  if (fromServer) {
    // 服务端回传的是原样文本：setRaw 会重建换行映射，CR/LF/CRLF 不经过 textarea 规范化
    origEditor.setRaw(st.original);
    revEditor.setRaw(st.revised);
    $("labels").value = JSON.stringify({ labels: st.labels }, null, 2);
    updateCounts();
  }
  renderAnalysis();
  const dl = $("download");
  if (st.has_result) {
    dl.href = st.download_url;
    dl.classList.remove("hidden");
  } else {
    dl.classList.add("hidden");
    $("result-preview").classList.add("hidden");
  }
}

/* ---------- 确认 ---------- */
async function confirmAll() {
  hideBanner();
  $("confirm-status").textContent = "";
  document.querySelectorAll(".label-card.conflict")
    .forEach((c) => c.classList.remove("conflict"));
  const sid = state.sessionId;
  const rev = state.revision;
  try {
    await api(`/api/sessions/${sid}/selections`, {
      method: "PUT",
      body: JSON.stringify({ revision: rev, selections: collectSelections() }),
    });
    const resp = await api(`/api/sessions/${sid}/confirm`, {
      method: "POST",
      body: JSON.stringify({ revision: rev }),
    });
    state.confirmed = true;
    $("confirm-status").textContent = "确认成功，结果已生成。";
    const dl = $("download");
    dl.href = resp.download_url;
    dl.classList.remove("hidden");
    const prev = $("result-preview");
    prev.textContent = JSON.stringify(resp.result, null, 2);
    prev.classList.remove("hidden");
  } catch (e) {
    const d = e.data && e.data.detail;
    if (e.status === 409 && d && d.code === "stale_revision") {
      showBanner("确认被拒绝：" + d.message + "（当前版本 r" + d.current_revision + "）", true);
      await reloadState();
    } else if (e.status === 409 && d && d.code === "conflict") {
      showBanner("确认被拒绝：" + d.message, true);
      (d.conflicting_labels || []).forEach((lid) => {
        const card = $("card-" + lid);
        if (card) card.classList.add("conflict");
      });
      $("confirm-status").textContent = "冲突标签：" + (d.conflicting_labels || []).join("、");
    } else if (e.status === 422 && d && d.code === "unresolved") {
      showBanner("确认被拒绝：" + d.message + "：" + (d.labels || []).join("、"), true);
    } else {
      showBanner("确认失败：" + detailMessage(e.data), true);
    }
  }
}

/* ---------- 轮询：发现别的窗口改了输入 ---------- */
async function reloadState() {
  if (!state.sessionId) return;
  const st = await api(`/api/sessions/${state.sessionId}`);
  applyState(st, true);
}

async function poll() {
  if (!state.sessionId) return;
  try {
    const st = await api(`/api/sessions/${state.sessionId}`);
    if (st.revision !== state.revision) {
      showBanner(`输入已在其他窗口修改（r${state.revision} → r${st.revision}），本页已刷新为最新分析，旧选择已失效。`);
      applyState(st, true);
    }
  } catch { /* 网络抖动忽略 */ }
}

/* ---------- 启动 ---------- */
function init() {
  // 换行码点编辑器接管两个正文 textarea；标签 JSON 仍为普通 textarea
  origEditor = new NLEditor($("original"), () => {});
  revEditor = new NLEditor($("revised"), () => {});
  // 暴露到 window 便于控制台调试与页面集成测试
  window.origEditor = origEditor;
  window.revEditor = revEditor;

  const sel = $("example-select");
  EXAMPLES.forEach((ex, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = ex.name;
    sel.appendChild(opt);
  });
  $("load-example").addEventListener("click", () => fillExample(Number(sel.value)));
  $("labels").addEventListener("input", updateCounts);
  $("save").addEventListener("click", saveInputs);
  $("confirm").addEventListener("click", confirmAll);
  updateCounts();

  const sid = new URLSearchParams(location.search).get("session");
  if (sid) {
    state.sessionId = sid;
    reloadState().catch(() => showBanner("会话不存在或加载失败", true));
  }
  state.pollTimer = setInterval(poll, 3000);
}

document.addEventListener("DOMContentLoaded", init);
