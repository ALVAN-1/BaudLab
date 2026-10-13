/**
 * 轻量 Markdown 渲染（AI 回复展示用，无外部依赖）
 * 支持：代码块、表格、标题、嵌套列表（有序/无序混排）、引用、分隔线、加粗、行内代码。
 * 安全性：先整体 HTML 转义，再只叠加本模块生成的无属性标签，不存在注入面。
 */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 行内：行内代码 → 加粗 → 链接（仅 http/https；点击由外层代理调系统浏览器） */
function inline(escaped) {
  let s = escaped.replace(/`([^`]+)`/g, (_, c) => `<code class="ai-inline-code">${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => `<a class="ai-link" href="${url}">${text}</a>`);
  return s;
}

/* 列表行：缩进 + 标记（- / * 无序，1. / 1、有序） */
const LIST_RE = /^(\s*)([-*]|\d+[.、])\s+(.*)$/;
const isOrderedMarker = (marker) => /\d/.test(marker);
const isBlankLine = (line) => /^\s*$/.test(line);

function indentOf(line) {
  return line.replace(/\t/g, '  ').length;
}

/* 向前看：跳过空行后（若有）返回下一个非空行下标，没有则返回 -1 */
function nextNonBlank(lines, i) {
  let j = i;
  while (j < lines.length && isBlankLine(lines[j])) j++;
  return j < lines.length ? j : -1;
}

/* 从 lines[i] 起收集同一缩进层级的列表项；更深缩进递归为子列表。
 * 兼容两种模型常见写法：
 *   1) 项间空行（松散列表）——空行后仍是本层列表项则列表继续（序号不重排）
 *   2) 子项不缩进（"1. 投菜"下一行直接 "- 字段"）——与基准类型不同的
 *      同缩进列表行并入上一项的子列表
 * 返回 [items, nextIndex]，item 形如 { ordered, text, children } */
function collectListItems(lines, i, baseIndent) {
  const first = LIST_RE.exec(lines[i]);
  const baseOrdered = first ? isOrderedMarker(first[2]) : false;
  const items = [];
  while (i < lines.length) {
    /* 项间空行：后面仍跟本层列表项则跳过继续，否则列表结束 */
    if (isBlankLine(lines[i])) {
      const j = nextNonBlank(lines, i);
      const m = j >= 0 ? LIST_RE.exec(lines[j]) : null;
      if (m && indentOf(m[1]) >= baseIndent && isOrderedMarker(m[2]) === baseOrdered) {
        i = j;
        continue;
      }
      break;
    }
    const m = LIST_RE.exec(lines[i]);
    if (!m) break;
    const indent = indentOf(m[1]);
    if (indent !== baseIndent) break;
    const item = { ordered: isOrderedMarker(m[2]), text: m[3], children: [] };
    i++;
    /* 收集子级与续行 */
    while (i < lines.length) {
      if (isBlankLine(lines[i])) {
        const j = nextNonBlank(lines, i);
        const m2 = j >= 0 ? LIST_RE.exec(lines[j]) : null;
        if (m2) {
          const ind2 = indentOf(m2[1]);
          if (ind2 > baseIndent || (ind2 === baseIndent && isOrderedMarker(m2[2]) !== baseOrdered)) {
            i = j; /* 子列表 / 混排子项前的空行，继续在本项内处理 */
            continue;
          }
        }
        break;
      }
      const m2 = LIST_RE.exec(lines[i]);
      if (m2) {
        const ind2 = indentOf(m2[1]);
        if (ind2 > baseIndent) {
          const [children, nextI] = collectListItems(lines, i, ind2);
          item.children.push(...children);
          i = nextI;
          continue;
        }
        if (ind2 === baseIndent && isOrderedMarker(m2[2]) !== baseOrdered) {
          /* 未缩进的混排子项：并入当前项（"1. 投菜" 下直接 "- 字段"） */
          item.children.push({ ordered: isOrderedMarker(m2[2]), text: m2[3], children: [] });
          i++;
          continue;
        }
        break; /* 同层同级项，交回外层 */
      }
      /* 非列表行：缩进续行并入当前项文本，顶格行结束本项 */
      if (/^\s+\S/.test(lines[i])) {
        item.text += ' ' + lines[i].trim();
        i++;
        continue;
      }
      break;
    }
    items.push(item);
  }
  return [items, i];
}

function renderListItems(items) {
  if (!items.length) return '';
  const tag = items[0].ordered ? 'ol' : 'ul';
  return `<${tag} class="ai-list">${items.map((it) =>
    `<li>${inline(it.text)}${renderListItems(it.children)}</li>`).join('')}</${tag}>`;
}

/* 块级解析（入参为已转义文本） */
function renderBlocks(escaped) {
  const lines = escaped.split('\n');
  let html = '';
  let pBuf = [];
  const closeP = () => {
    if (!pBuf.length) return '';
    const s = `<span class="ai-p">${inline(pBuf.join('<br>'))}</span>`;
    pBuf = [];
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    /* 表格：当前行为 |...| 且下一行为 |---| 分隔行 */
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      html += closeP();
      const header = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      html += `<table class="ai-table"><thead><tr>${header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${header.map((_, ci) => `<td>${inline(r[ci] ?? '')}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
      continue;
    }

    /* 标题 # ~ ####：分级样式；"1. xxx / 1、xxx / 1 xxx" 序号提取为徽章 */
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) {
      html += closeP();
      const level = h[1].length;
      const cls = level <= 1 ? 'ai-h ai-h1' : (level === 2 ? 'ai-h ai-h2' : 'ai-h ai-h3');
      let body = h[2];
      let badge = '';
      const nm = body.match(/^([1-9])[.、]\s*(.*)$|^([1-9])\s+(\S.*)$/);
      if (nm) {
        badge = `<span class="ai-h-badge">${nm[1] || nm[3]}</span>`;
        body = nm[2] || nm[4];
      }
      html += `<div class="${cls}">${badge}${inline(body)}</div>`;
      i++;
      continue;
    }

    /* 分隔线 --- */
    if (/^\s*-{3,}\s*$/.test(line)) {
      html += closeP();
      html += '<hr class="ai-hr">';
      i++;
      continue;
    }

    /* 列表（支持嵌套缩进） */
    const lm = LIST_RE.exec(line);
    if (lm) {
      html += closeP();
      const [items, nextI] = collectListItems(lines, i, indentOf(lm[1]));
      html += renderListItems(items);
      i = nextI;
      continue;
    }

    /* 引用 >（转义后为 &gt;） */
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) {
      html += closeP();
      html += `<div class="ai-quote">${inline(bq[1])}</div>`;
      i++;
      continue;
    }

    if (/^\s*$/.test(line)) {
      html += closeP();
      i++;
      continue;
    }

    pBuf.push(line);
    i++;
  }
  html += closeP();
  return html;
}

export function renderMarkdown(text) {
  if (!text) return '';
  const parts = String(text).replace(/\r\n/g, '\n').split('```');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      /* 代码块：首行可能是语言标注 */
      const nl = parts[i].indexOf('\n');
      const code = nl >= 0 ? parts[i].slice(nl + 1) : parts[i];
      out += `<pre class="ai-code">${escapeHtml(code.replace(/\n$/, ''))}</pre>`;
    } else {
      out += renderBlocks(escapeHtml(parts[i]));
    }
  }
  return out;
}
