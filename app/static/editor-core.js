"use strict";

/*
 * 换行码点编辑器的纯逻辑层（无 DOM 依赖，可在 Node 下单测）。
 *
 * 背景：HTML <textarea> 的 value 按规范会把 CR、CRLF 统一规范化成 LF，
 * 直接用 textarea.value 保存会静默丢掉正文里的 CR。这里的做法是：
 *
 *   - raw  ：待保存的“原样文本”，可混用 CR(\r)、LF(\n)、CRLF(\r\n)；
 *   - norm ：把所有换行规范化为 LF 后的文本，与 textarea.value 一致，
 *             用户实际打字、粘贴、选区都发生在 norm 上；
 *   - 映射 ：norm 码点下标 <-> raw 码点下标（CRLF 两个码点在 norm 里
 *             只占一个 \n 的位置）。
 *
 * 所有下标均按 Unicode 码点计算（与服务端 len(str)、标签区间一致），
 * 不用 UTF-16 码元；DOM 层负责把 textarea 的码元偏移转成码点偏移。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NLEditorCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  function codepoints(s) {
    return Array.from(s);
  }

  function isNL(ch) {
    return ch === "\r" || ch === "\n";
  }

  /* CRLF / 单独 CR / LF 一律规范化成单个 LF。 */
  function normalizeNL(raw) {
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "\r") {
        out += "\n";
        if (raw[i + 1] === "\n") i++;   // 跳过 CRLF 的 LF
      } else {
        out += ch;
      }
    }
    return out;
  }

  /*
   * 构造 norm 与双向映射（下标均为码点）：
   *   n2r[k]：norm 第 k 个码点对应 raw 中的起始码点下标
   *           （norm 的 \n 一律指向换行组的第一个码点，CRLF 时指向 \r）
   *   r2n[i]：raw 第 i 个码点对应的 norm 下标
   *           （CRLF 的 \r 与 \n 指向同一个 norm 下标）
   */
  function buildNorm(raw) {
    const cps = Array.from(raw);
    let norm = "";
    const n2r = [];
    const r2n = new Array(cps.length);
    let k = 0;
    for (let i = 0; i < cps.length; ) {
      const ch = cps[i];
      if (ch === "\r") {
        norm += "\n";
        n2r.push(i);
        r2n[i] = k;
        if (cps[i + 1] === "\n") {
          r2n[i + 1] = k;
          i += 2;
        } else {
          i += 1;
        }
        k++;
      } else {
        norm += ch;
        n2r.push(i);
        r2n[i] = k;
        i++;
        k++;
      }
    }
    return { norm, n2r, r2n };
  }

  /* 枚举 raw 中每个换行组：{rawI, end, normI, type}。 */
  function classify(raw) {
    const cps = Array.from(raw);
    const { r2n } = buildNorm(raw);
    const groups = [];
    for (let i = 0; i < cps.length; ) {
      if (cps[i] === "\r") {
        if (cps[i + 1] === "\n") {
          groups.push({ rawI: i, end: i + 2, normI: r2n[i], type: "crlf" });
          i += 2;
        } else {
          groups.push({ rawI: i, end: i + 1, normI: r2n[i], type: "cr" });
          i += 1;
        }
      } else if (cps[i] === "\n") {
        groups.push({ rawI: i, end: i + 1, normI: r2n[i], type: "lf" });
        i += 1;
      } else {
        i++;
      }
    }
    return groups;
  }

  function cpSlice(s, start, end) {
    const cps = Array.from(s);
    return cps.slice(start, end === undefined ? undefined : end).join("");
  }

  /* 换行组在 raw 里占几个码点。 */
  function groupWidthAt(cps, rawI) {
    return cps[rawI] === "\r" && cps[rawI + 1] === "\n" ? 2 : 1;
  }

  /*
   * LCS 最短差异：把 A 变成 B 的若干连续改动块。
   * 返回 [{aStart, aEnd, text}]：把 A[aStart:aEnd] 替换成 text。
   * 等号部分不出现在改动块里，保证未编辑字符原样保留。
   */
  function lcsHunks(aStr, bStr) {
    const A = Array.from(aStr);
    const B = Array.from(bStr);
    const m = A.length;
    const n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = A[i - 1] === B[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const acts = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
        acts.push({ k: "e" });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        acts.push({ k: "i", ch: B[j - 1] });
        j--;
      } else {
        acts.push({ k: "d" });
        i--;
      }
    }
    acts.reverse();

    const hunks = [];
    let ai = 0;
    let bi = 0;
    for (let p = 0; p < acts.length; ) {
      if (acts[p].k === "e") {
        p++; ai++; bi++;
        continue;
      }
      const aStart = ai;
      let aEnd = ai;
      let text = "";
      while (p < acts.length && acts[p].k !== "e") {
        if (acts[p].k === "d") {
          aEnd++;
          ai++;
        } else {
          text += acts[p].ch;
          bi++;
        }
        p++;
      }
      hunks.push({ aStart, aEnd, text });
    }
    return hunks;
  }

  /*
   * textarea 上的普通编辑（打字、删除、回车、IME 组词等）：
   * 已知编辑前的 raw 与编辑后的 norm(newNorm)，反推新的 raw。
   *
   * 关键性质：
   *   - LCS 改动块之外的码点完全不动（字符与换行形式都原样保留）；
   *   - 删掉 norm 里的 \n 时，连同它在 raw 中代表的整个换行组
   *     （CRLF 就是 \r、\n 两个码点）一起删除；
   *   - 新输入的换行（textarea 只能给出 \n）以 LF 形式进入 raw，
   *     之后可用工具栏单独转换成 CR / CRLF。
   */
  function applyNormEdit(raw, newNorm) {
    const info = buildNorm(raw);
    if (info.norm === newNorm) return raw;
    const rawCps = Array.from(raw);
    const hunks = lcsHunks(info.norm, newNorm);
    let out = raw;
    // 从后往前应用，前面改动块的 raw 下标不会受影响
    for (let h = hunks.length - 1; h >= 0; h--) {
      const { aStart, aEnd, text } = hunks[h];
      const rStart = aStart < info.n2r.length ? info.n2r[aStart] : rawCps.length;
      let rEnd;
      if (aEnd > aStart) {
        const li = info.n2r[aEnd - 1];
        rEnd = li + groupWidthAt(rawCps, li);
      } else {
        rEnd = rStart;
      }
      out = cpSlice(out, 0, rStart) + text + cpSlice(out, rEnd);
    }
    return out;
  }

  /*
   * 按 raw 码点做一次替换（粘贴/拖拽/换行类型转换走这里），
   * 入参选区是 norm 码点区间，insert 是原样文本（可含任意换行形式）。
   */
  function spliceRaw(raw, normCpStart, normCpEnd, insert) {
    const info = buildNorm(raw);
    const rawCps = Array.from(raw);
    const rStart = normCpStart < info.n2r.length
      ? info.n2r[normCpStart] : rawCps.length;
    let rEnd;
    if (normCpEnd > normCpStart) {
      const li = info.n2r[normCpEnd - 1];
      rEnd = li + groupWidthAt(rawCps, li);
    } else {
      rEnd = rStart;
    }
    return cpSlice(raw, 0, rStart) + insert + cpSlice(raw, rEnd);
  }

  /* 把某个换行组转换成指定类型；norm 不变，所以光标位置不变。 */
  function convertNewline(raw, group, type) {
    const insert = type === "crlf" ? "\r\n" : type === "cr" ? "\r" : "\n";
    return spliceRaw(raw, group.normI, group.normI + 1, insert);
  }

  /*
   * norm 码点选区 -> raw 码点区间。
   * 选区结束位置若落在 CRLF 换行组之后，结束边界包含整个换行组，
   * 这样“只覆盖 CRLF 一半”的标签也能报出精确的 raw 下标。
   */
  function selectionToRaw(raw, normCpStart, normCpEnd) {
    const info = buildNorm(raw);
    const rawCps = Array.from(raw);
    const rStart = normCpStart < info.n2r.length
      ? info.n2r[normCpStart] : rawCps.length;
    let rEnd;
    if (normCpEnd === normCpStart) {
      rEnd = rStart;
    } else if (normCpEnd >= info.n2r.length) {
      rEnd = rawCps.length;
    } else {
      const li = info.n2r[normCpEnd - 1];
      rEnd = li + groupWidthAt(rawCps, li);
    }
    return { start: rStart, end: rEnd };
  }

  /* 统计：码点总数与三种换行的数量。 */
  function stats(raw) {
    const cps = Array.from(raw);
    let cr = 0;
    let lf = 0;
    let crlf = 0;
    for (let i = 0; i < cps.length; ) {
      if (cps[i] === "\r") {
        if (cps[i + 1] === "\n") { crlf++; i += 2; }
        else { cr++; i++; }
      } else if (cps[i] === "\n") {
        lf++; i++;
      } else {
        i++;
      }
    }
    return { cp: cps.length, cr, lf, crlf };
  }

  return {
    codepoints,
    isNL,
    normalizeNL,
    buildNorm,
    classify,
    lcsHunks,
    applyNormEdit,
    spliceRaw,
    convertNewline,
    selectionToRaw,
    stats,
  };
});
