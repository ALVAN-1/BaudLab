<template>
  <div class="view-pad help-view">
    <div class="view-header">
      <h2>帮助文档</h2>
      <button class="help-open-github" @click="openGithub">在 GitHub 查看</button>
    </div>

    <!-- Banner 区域（如果 markdown 顶部有 banner 图的话） -->
    <div v-if="bannerImage" class="help-banner">
      <img :src="bannerImage" alt="banner" class="help-banner-img" />
    </div>

    <div class="help-content" v-html="renderedMarkdown" @click="onContentClick"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';

const rawMarkdown = ref('');

onMounted(async () => {
  if (window.electronAPI?.readme?.get) {
    try { rawMarkdown.value = await window.electronAPI.readme.get(); } catch { /* ignore */ }
  }
});

// 从 markdown 里提取第一张 ![...](url) 图片（通常是 banner）
const bannerImage = computed(() => {
  if (!rawMarkdown.value) return '';
  const m = rawMarkdown.value.match(/!\[[^\]]*\]\(([^)]+)\)/);
  return m ? m[1] : '';
});

// 简易 Markdown 渲染
const renderedMarkdown = computed(() => {
  if (!rawMarkdown.value) return '<p style="color:var(--text-tertiary)">加载中...</p>';
  let html = rawMarkdown.value;
  // 去掉第一张图片（已在 banner 区独立显示，避免重复）
  html = html.replace(/^\s*!\[[^\]]*\]\([^)]+\)\s*\n?/, '');

  // 转义 HTML（注意：我们是先处理图片再转义，下面会做未转义的恢复）
  // 先保护 URL / 行内代码中的特殊字符
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 代码块 ```lang ... ```
  html = html.replace(/```[\s\S]*?```/g, (m) => {
    const code = m.replace(/```\w*\n?/, '').replace(/```$/, '');
    return `<pre class="md-code">${code}</pre>`;
  });

  // 表格 | ... | ... |
  html = html.replace(/((?:^\|.*\|$\n?)+)/gm, (block) => {
    const lines = block.trim().split('\n');
    if (lines.length < 2) return block;
    const sep = lines[1];
    if (!/^\|[\s:|-]+\|$/.test(sep)) return block;
    const rows = [lines[0], ...lines.slice(2)];
    let table = '<table class="md-table"><thead><tr>';
    const headers = lines[0].split('|').filter(c => c.trim());
    headers.forEach(h => { table += `<th>${h.trim()}</th>`; });
    table += '</tr></thead><tbody>';
    rows.slice(1).forEach(r => {
      const cells = r.split('|').filter(c => c.trim());
      table += '<tr>';
      cells.forEach(c => { table += `<td>${c.trim()}</td>`; });
      table += '</tr>';
    });
    table += '</tbody></table>';
    return table;
  });

  // 行内图片 ![alt](url) —— 不在 banner 的就作为正文插图渲染
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    return `<p class="md-img-wrap"><img class="md-img" src="${url}" alt="${alt}" /></p>`;
  });

  // 标题 # ## ###
  // 把第一个 H1（`# ...`）做成 banner 样式
  let h1Count = 0;
  html = html.replace(/^# (.+)$/gm, (_m, text) => {
    h1Count++;
    if (h1Count === 1) {
      return `<div class="md-banner-card">
        <h1 class="md-h1-banner">${text}</h1>
      </div>`;
    }
    return `<h2 class="md-h2">${text}</h2>`;
  });
  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h3">$1</h3>');

  // 行内代码 `code`
  html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // 引用块 > xxx
  html = html.replace(/(?:^&gt; .+$\n?)+/gm, (block) => {
    const inner = block.split('\n').map(l => l.replace(/^&gt; /, '')).join('\n');
    return `<blockquote class="md-blockquote">${inner}</blockquote>`;
  });

  // 粗体 **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a data-link="$2" class="md-link">$1</a>');

  // 无序列表 - item
  html = html.replace(/(?:^- (.+)$\n?)+/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
    return `<ul class="md-ul">${items}</ul>`;
  });

  // 段落（连续非空行）
  html = html.replace(/^(?!<(?:h[1-4]|div|pre|table|ul|blockquote|p)|\s*$)(.+)$/gm, '<p class="md-p">$1</p>');

  return html;
});

// 点击 md-link -> 外部打开
function onContentClick(e) {
  const el = e.target.closest('a[data-link]');
  if (!el) return;
  e.preventDefault();
  const url = el.getAttribute('data-link');
  if (url && window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal(url);
  }
}

function openGithub() {
  if (window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal('https://github.com/ALVAN-1/BaudLab.io');
  }
}
</script>

<style scoped>
.help-view { display: flex; flex-direction: column; height: 100%; gap: 12px; }
.view-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.view-header h2 { font-size: 18px; font-weight: 600; margin: 0; }
.help-open-github {
  padding: 4px 12px; border-radius: 6px; font-size: 13px;
  border: 1px solid var(--border-light); background: var(--bg-secondary); color: var(--accent-blue);
  cursor: pointer;
}
.help-open-github:hover { border-color: var(--accent-blue); }

.help-banner {
  width: 100%; flex-shrink: 0;
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 6px 24px rgba(0,0,0,0.08);
  background: var(--bg-secondary);
}
.help-banner-img { display: block; width: 100%; height: auto; max-height: 220px; object-fit: cover; }

.help-content {
  flex: 1; overflow-y: auto;
  padding: 20px 28px 40px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 8px;
}

:deep(.md-banner-card) {
  margin: 0 0 20px; padding: 24px 28px;
  border-radius: 12px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  box-shadow: 0 10px 30px rgba(102, 126, 234, 0.25);
}
:deep(.md-h1-banner) {
  font-size: 26px; font-weight: 700; margin: 0; color: #fff;
  letter-spacing: 0.3px;
}

:deep(.md-h2) { font-size: 20px; font-weight: 700; margin: 28px 0 12px; color: var(--text-primary); border-left: 4px solid var(--accent-blue); padding-left: 10px; }
:deep(.md-h3) { font-size: 16px; font-weight: 600; margin: 22px 0 8px; color: var(--text-primary); }
:deep(.md-h4) { font-size: 14px; font-weight: 600; margin: 16px 0 6px; color: var(--text-secondary); }
:deep(.md-p) { font-size: 14px; line-height: 1.8; color: var(--text-primary); margin: 8px 0; }
:deep(.md-ul) { margin: 8px 0; padding-left: 22px; }
:deep(.md-ul li) { font-size: 14px; line-height: 1.8; color: var(--text-primary); margin: 4px 0; }
:deep(.md-inline-code) { background: var(--bg-hover); padding: 2px 6px; border-radius: 4px; font-size: 13px; font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--accent-violet); }
:deep(.md-code) { display: block; background: var(--bg-hover); border-radius: 8px; padding: 14px 18px; margin: 14px 0; font-size: 13px; font-family: ui-monospace, Menlo, Consolas, monospace; overflow-x: auto; white-space: pre; line-height: 1.6; color: var(--text-primary); border-left: 3px solid var(--accent-blue); }
:deep(.md-table) { width: 100%; border-collapse: collapse; margin: 14px 0; overflow: hidden; border-radius: 8px; border: 1px solid var(--border-light); }
:deep(.md-table th) { padding: 10px 14px; text-align: left; font-size: 13px; font-weight: 600; background: var(--bg-hover); border-bottom: 2px solid var(--border-light); color: var(--text-secondary); }
:deep(.md-table td) { padding: 8px 14px; font-size: 13px; border-bottom: 1px solid var(--border-light); color: var(--text-primary); }
:deep(.md-table tr:last-child td) { border-bottom: none; }
:deep(.md-table tr:hover td) { background: var(--bg-hover); }
:deep(.md-link) { color: var(--accent-blue); text-decoration: none; cursor: pointer; }
:deep(.md-link:hover) { text-decoration: underline; }

:deep(.md-blockquote) {
  margin: 12px 0; padding: 10px 14px;
  border-left: 4px solid var(--accent-amber);
  background: rgba(245, 158, 11, 0.06);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 14px; line-height: 1.7;
}

:deep(.md-img-wrap) { margin: 16px 0; text-align: center; }
:deep(.md-img) { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--border-light); box-shadow: 0 4px 16px rgba(0,0,0,0.05); }
</style>
