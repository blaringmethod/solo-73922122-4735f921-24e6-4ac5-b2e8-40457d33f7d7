"use strict";

/*
 * 落点预览的纯渲染函数（无 DOM 依赖，可在 Node 下单测）。
 *
 * 把原样文本渲染成逐码点 HTML，[start, end) 为原样文本（raw）码点的
 * 左闭右开区间：
 *   - 普通字符在区间内时包一层 <mark>；
 *   - 每个换行组（CRLF 是两个码点）渲染成 .nl-mark 徽章；
 *   - 标签只覆盖 CRLF 一半时，徽章加 .nl-half 且仅高亮被覆盖的那一半
 *     （CR 或 LF），具体覆盖哪一侧一目了然。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PreviewCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  const NL_GLYPH = { crlf: "⏎", cr: "␍", lf: "␊" };
  const NL_NAME = { crlf: "CRLF", cr: "CR", lf: "LF" };

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
         '"': "&quot;", "'": "&#39;" }[c]));
  }

  function tokenPreview(raw, start, end) {
    const cps = Array.from(raw);
    let html = "";
    for (let i = 0; i < cps.length; ) {
      const ch = cps[i];
      if (ch === "\r" || ch === "\n") {
        const type = ch === "\r" && cps[i + 1] === "\n"
          ? "crlf" : ch === "\r" ? "cr" : "lf";
        if (type === "crlf") {
          const crIn = start <= i && i < end;
          const lfIn = start <= i + 1 && i + 1 < end;
          const half = (crIn || lfIn) && !(crIn && lfIn);
          const cls = "nl-mark nl-crlf" + (half ? " nl-half" : "");
          const title = `CRLF 两个码点：[${i}] CR, [${i + 1}] LF` +
            ((crIn || lfIn)
              ? `；标签覆盖 ${crIn ? "CR" : ""}${crIn && lfIn ? "+" : ""}${lfIn ? "LF" : ""}`
              : "");
          html += `<span class="${cls}" title="${escapeHtml(title)}">` +
            (crIn ? "<mark>␍</mark>" : "␍") +
            (lfIn ? "<mark>␊</mark>" : "␊") +
            "</span>";
          i += 2;
        } else {
          const inside = start <= i && i < end;
          // 单个换行码点只有“覆盖/未覆盖”，不存在半覆盖；nl-half 仅用于 CRLF
          const cls = "nl-mark nl-" + type;
          const title = `${NL_NAME[type]} 码点 [${i}]` +
            (inside ? "；标签覆盖该码点" : "");
          html += `<span class="${cls}" title="${escapeHtml(title)}">` +
            (inside ? `<mark>${NL_GLYPH[type]}</mark>` : NL_GLYPH[type]) +
            "</span>";
          i += 1;
        }
      } else {
        const inside = start <= i && i < end;
        html += inside ? `<mark>${escapeHtml(ch)}</mark>` : escapeHtml(ch);
        i += 1;
      }
    }
    return html;
  }

  return { tokenPreview, escapeHtml, NL_GLYPH, NL_NAME };
});
