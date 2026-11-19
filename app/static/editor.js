"use strict";

/*
 * 换行码点编辑器（DOM 层）。
 *
 * 结构：
 *   .nl-editor
 *     .nl-surface
 *       pre.nl-backdrop          渲染 raw 文本：换行组显示成可见徽章
 *       textarea.nl-textarea     透明文字层，负责原生编辑/粘贴/IME
 *     .nl-toolbar
 *       转 CRLF / LF / CR 按钮 + 码点统计 + 选区 raw 区间
 *
 * textarea.value 永远是 normalizeNL(raw)（与浏览器自己的规范化一致，
 * 因此光标、选区、IME 全部走原生路径）；raw 与 value 的同步在
 * editor-core.js 的纯函数里完成，未编辑字符与换行形式原样保留。
 */
(function () {
  const C = window.NLEditorCore;

  const NL_SYMBOL = { crlf: "⏎", cr: "␍", lf: "␊" };
  const NL_TITLE = { crlf: "CRLF (\\r\\n)", cr: "CR (\\r)", lf: "LF (\\n)" };

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* textarea 码元偏移 -> 码点偏移。 */
  function u16ToCp(str, u16) {
    return Array.from(str.slice(0, u16)).length;
  }

  function cpToU16(str, cp) {
    let count = 0;
    let units = 0;
    for (const ch of str) {
      if (count >= cp) break;
      units += ch.length;
      count++;
    }
    return units;
  }

  /* 渲染 backdrop：按逻辑行分块，换行组渲染成可点击徽章。 */
  function renderBackdrop(raw) {
    const groups = C.classify(raw);
    const cps = C.codepoints(raw);
    const lines = [];
    let line = "";
    for (let i = 0; i < cps.length; ) {
      if (cps[i] === "\r" || cps[i] === "\n") {
        const g = groups.find((x) => x.rawI === i);
        const type = g.type;
        line += `<span class="nl-mark nl-${type}" data-normi="${g.normI}"` +
          ` title="${NL_TITLE[type]}，点击可在 CR/LF/CRLF 间循环切换">` +
          `<span class="nl-glyph">${NL_SYMBOL[type]}</span></span>`;
        lines.push(line);
        line = "";
        i += type === "crlf" ? 2 : 1;
      } else {
        line += escapeHtml(cps[i]);
        i++;
      }
    }
    lines.push(line);   // 最后一行（含文本以换行结尾时的空行）
    return lines.map((l) => `<span class="nl-line">${l}</span>`).join("");
  }

  class NLEditor {
    constructor(textarea, onChange) {
      this.ta = textarea;
      this.onChange = onChange || function () {};
      // textarea 赋值瞬间浏览器就会把 CR/CRLF 规范化成 LF，raw 无法从
      // value 还原；初始原样文本通过 data-raw 属性传入（HTML 转义安全）。
      this.raw = textarea.dataset.nlRaw != null
        ? textarea.dataset.nlRaw : (textarea.value || "");
      delete textarea.dataset.nlRaw;
      this._suppress = false;
      this._composing = false;

      const wrap = document.createElement("div");
      wrap.className = "nl-editor";
      textarea.parentNode.insertBefore(wrap, textarea);

      this.surface = document.createElement("div");
      this.surface.className = "nl-surface";
      this.backdrop = document.createElement("pre");
      this.backdrop.className = "nl-backdrop";
      this.backdrop.setAttribute("aria-hidden", "true");
      textarea.classList.add("nl-textarea");
      textarea.removeAttribute("maxlength");
      textarea.spellcheck = false;
      textarea.wrap = "off";
      this.surface.appendChild(this.backdrop);
      this.surface.appendChild(textarea);

      this.toolbar = document.createElement("div");
      this.toolbar.className = "nl-toolbar";
      this.toolbar.innerHTML =
        '<span class="nl-tools">' +
        '<button type="button" data-nl="crlf" title="把光标处（或选区内每一个）换行转为 CRLF">转 CRLF ⏎</button>' +
        '<button type="button" data-nl="lf" title="把光标处（或选区内每一个）换行转为 LF">转 LF ␊</button>' +
        '<button type="button" data-nl="cr" title="把光标处（或选区内每一个）换行转为 CR">转 CR ␍</button>' +
        '</span>' +
        '<span class="nl-stats"></span>' +
        '<span class="nl-selrange"></span>';
      wrap.appendChild(this.surface);
      wrap.appendChild(this.toolbar);

      this._bind();
      this.setRaw(this.raw, /*notify=*/false);
    }

    _bind() {
      const ta = this.ta;
      ta.addEventListener("compositionstart", () => { this._composing = true; });
      ta.addEventListener("compositionend", () => {
        this._composing = false;
        this._syncFromTextarea();
      });
      ta.addEventListener("input", () => {
        if (!this._composing) this._syncFromTextarea();
      });
      ta.addEventListener("scroll", () => this._syncScroll());
      ta.addEventListener("keyup", () => this._updateSelRange());
      ta.addEventListener("click", () => this._updateSelRange());
      ta.addEventListener("select", () => this._updateSelRange());

      // 粘贴：浏览器已把粘贴内容规范化为 LF，这里保留其换行；
      // 拖拽同理（拖拽落点可能与当前选区不同）。
      ta.addEventListener("paste", (e) => {
        const pasted = e.clipboardData && e.clipboardData.getData("text/plain");
        if (pasted == null) return;
        e.preventDefault();
        this._insertAtSelection(C.normalizeNL(pasted));
      });
      ta.addEventListener("drop", (e) => {
        const dropped = e.dataTransfer && e.dataTransfer.getData("text/plain");
        if (dropped == null) return;
        e.preventDefault();
        // textarea 内部坐标无法可靠换算成 value 偏移，拖放统一落在当前选区
        this._insertAtSelection(C.normalizeNL(dropped));
      });

      // 点击徽章：循环切换 CR -> LF -> CRLF -> CR
      this.backdrop.addEventListener("click", (e) => {
        const mark = e.target.closest(".nl-mark");
        if (!mark) return;
        const normI = Number(mark.dataset.normi);
        const groups = C.classify(this.raw);
        const g = groups.find((x) => x.normI === normI);
        if (!g) return;
        const next = g.type === "cr" ? "lf" : g.type === "lf" ? "crlf" : "cr";
        this.setRaw(C.convertNewline(this.raw, g, next));
        ta.focus();
      });

      this.toolbar.querySelectorAll("button[data-nl]").forEach((btn) => {
        btn.addEventListener("click", () => {
          ta.focus();
          this._convertSelection(btn.dataset.nl);
        });
      });
    }

    /* 当前选区的码点形式。 */
    _cpSelection() {
      const v = this.ta.value;
      return {
        start: u16ToCp(v, this.ta.selectionStart || 0),
        end: u16ToCp(v, this.ta.selectionEnd || 0),
      };
    }

    _syncScroll() {
      // textarea 是唯一可滚动层（backdrop overflow:hidden），单向同步即可
      this.backdrop.scrollTop = this.ta.scrollTop;
      this.backdrop.scrollLeft = this.ta.scrollLeft;
    }

    _syncFromTextarea() {
      if (this._suppress) return;
      const next = C.applyNormEdit(this.raw, this.ta.value);
      this.raw = next;
      this._render();
      this.onChange(this.raw);
    }

    _insertAtSelection(text, cpStart, cpEnd) {
      const sel = this._cpSelection();
      if (cpStart == null) { cpStart = sel.start; cpEnd = sel.end; }
      const next = C.spliceRaw(this.raw, cpStart, cpEnd, text);
      const info = C.buildNorm(next);
      const cpCaret = cpStart + C.codepoints(text).length;
      this.setRaw(next);
      const u = cpToU16(info.norm, cpCaret);
      this.ta.setSelectionRange(u, u);
    }

    _convertSelection(type) {
      const sel = this._cpSelection();
      const groups = C.classify(this.raw);
      let changed = false;
      let next = this.raw;
      for (const g of groups) {
        const inside = g.normI >= sel.start && g.normI < sel.end;
        const atCaret = sel.start === sel.end &&
          (g.normI === sel.start || g.normI === sel.start - 1);
        if ((inside || atCaret) && g.type !== type) {
          next = C.convertNewline(next, C.classify(next).find(
            (x) => x.normI === g.normI), type);
          changed = true;
        }
      }
      if (changed) this.setRaw(next);
    }

    setRaw(raw, notify) {
      this.raw = raw;
      this._suppress = true;
      this.ta.value = C.normalizeNL(raw);
      this._suppress = false;
      this._render();
      if (notify !== false) this.onChange(this.raw);
    }

    getRaw() {
      return this.raw;
    }

    _render() {
      this.backdrop.innerHTML = renderBackdrop(this.raw);
      this.backdrop.scrollTop = this.ta.scrollTop;
      this.backdrop.scrollLeft = this.ta.scrollLeft;
      this._updateStats();
      this._updateSelRange();
    }

    _updateStats() {
      const st = C.stats(this.raw);
      const el = this.toolbar.querySelector(".nl-stats");
      el.textContent =
        `${st.cp} / 120 码点 · 换行：CRLF ×${st.crlf}，LF ×${st.lf}，CR ×${st.cr}`;
      el.classList.toggle("nl-over", st.cp > 120);
    }

    _updateSelRange() {
      const sel = this._cpSelection();
      const r = C.selectionToRaw(this.raw, sel.start, sel.end);
      const el = this.toolbar.querySelector(".nl-selrange");
      if (sel.start === sel.end) {
        el.textContent = `光标 raw 码点：${r.start}`;
      } else {
        el.textContent = `选区 raw 码点区间：[${r.start}, ${r.end})` +
          `（${r.end - r.start} 个码点）`;
      }
    }
  }

  window.NLEditor = NLEditor;
})();
