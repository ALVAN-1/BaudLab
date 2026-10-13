<template>
  <div class="modal-overlay mcp-guide-overlay" @click.self="$emit('close')">
    <div class="mcp-guide-dialog" role="dialog" aria-label="MCP 配置指南">
      <div class="mcp-guide-header">
        <h3>MCP 配置</h3>
        <button class="mcp-guide-close" title="关闭" @click="$emit('close')">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-close"/></svg>
        </button>
      </div>

      <div class="mcp-guide-body">
        <!-- 左侧客户端列表 -->
        <aside class="mcp-guide-nav">
          <button
            v-for="c in clients"
            :key="c.id"
            type="button"
            class="mcp-guide-nav-item"
            :class="{ on: activeId === c.id }"
            @click="activeId = c.id"
          >
            <span class="mcp-guide-nav-icon" :style="{ background: c.color }">{{ c.monogram }}</span>
            <span>{{ c.name }}</span>
          </button>
        </aside>

        <!-- 右侧配置内容 -->
        <section class="mcp-guide-content">
          <div class="mcp-guide-manual-title">手动配置</div>

          <template v-for="block in active.blocks" :key="block.title">
            <div class="mcp-guide-method">{{ block.title }}</div>
            <ol class="mcp-guide-steps">
              <li v-for="(s, i) in block.steps" :key="i" v-html="s"></li>
            </ol>
            <div v-if="block.code" class="mcp-guide-code-wrap">
              <pre class="mcp-guide-code">{{ block.code }}</pre>
              <button type="button" class="mcp-guide-copy" :title="copiedKey === block.title ? '已复制' : '复制'" @click="copyCode(block)">
                <svg v-if="copiedKey === block.title" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>
          </template>

          <p class="mcp-guide-note">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" style="flex-shrink:0;margin-top:2px;"><use href="#i-alert-circle"/></svg>
            <span>配置里的 mcp-server.js 路径已按当前运行环境自动填好；桌面应用开着为在线模式（串口收发、写操作可用），没开则自动退化为只读直读数据库。</span>
          </p>
        </section>
      </div>

      <div class="mcp-guide-footer">
        <a class="mcp-guide-link" @click="openTutorial">查看使用教程</a>
        <button class="btn btn-primary mcp-guide-done" @click="$emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const emit = defineEmits(['close']);

const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
const serverPath = ref('');

/* 通用 stdio 配置（路径按运行环境自动填充） */
const stdioJson = computed(() => JSON.stringify({
  mcpServers: {
    'serial-protocol-manager': {
      command: 'node',
      args: [serverPath.value || '<mcp-server.js 路径>'],
    },
  },
}, null, 2));
/* VS Code 的 MCP 配置顶层键是 servers（其余客户端都是 mcpServers） */
const vscodeJson = computed(() => JSON.stringify({
  servers: {
    'serial-protocol-manager': {
      command: 'node',
      args: [serverPath.value || '<mcp-server.js 路径>'],
    },
  },
}, null, 2));
/* Codex CLI 使用 TOML 配置 */
const codexToml = computed(() =>
  `[mcp_servers.serial-protocol-manager]\ncommand = "node"\nargs = ["${serverPath.value || '<mcp-server.js 路径>'}"]`
);
const claudeCodeCmd = computed(() =>
  `claude mcp add serial-protocol-manager -- node "${serverPath.value || '<mcp-server.js 路径>'}"`
);

const clients = computed(() => [
  {
    id: 'claude-desktop', name: 'Claude Desktop', color: '#D97757', monogram: 'CD',
    blocks: [
      {
        title: '方式一（推荐）：修改配置文件',
        steps: [
          '打开 Claude Desktop → <b>设置 → 开发者 → 编辑配置</b>（或直接打开 <code>%APPDATA%\\Claude\\claude_desktop_config.json</code>）',
          '加入如下内容后保存',
        ],
        code: stdioJson.value,
      },
      {
        title: '方式二：验证接入',
        steps: ['完全退出并重启 Claude Desktop，对话输入框出现工具（扳手/插头）图标即接入成功'],
        code: '',
      },
    ],
  },
  {
    id: 'claude-code', name: 'Claude Code', color: '#C15F3C', monogram: 'CC',
    blocks: [
      {
        title: '方式一（推荐）：终端一条命令',
        steps: ['在终端执行以下命令，完成即可在会话中使用'],
        code: claudeCodeCmd.value,
      },
      {
        title: '方式二：手动编辑配置文件',
        steps: ['编辑项目根目录 <code>.mcp.json</code>（团队共享）或 <code>~/.claude.json</code>（个人全局），加入如下内容；重启会话后运行 <code>/mcp</code> 查看连接状态'],
        code: stdioJson.value,
      },
    ],
  },
  {
    id: 'codex', name: 'Codex / ChatGPT', color: '#10A37F', monogram: 'CX',
    blocks: [
      {
        title: '编辑 config.toml',
        steps: [
          '编辑 Codex CLI 配置文件 <code>~/.codex/config.toml</code>',
          '加入如下内容后保存并重启 Codex',
        ],
        code: codexToml.value,
      },
    ],
  },
  {
    id: 'cursor', name: 'Cursor', color: '#5B6470', monogram: 'Cu',
    blocks: [
      {
        title: '方式一（推荐）：配置文件',
        steps: [
          '项目根新建 <code>.cursor/mcp.json</code>（全局配置则放在 <code>~/.cursor/mcp.json</code>）',
          '加入如下内容后保存',
        ],
        code: stdioJson.value,
      },
      {
        title: '方式二：图形界面',
        steps: ['打开 Cursor 设置 → <b>MCP &amp; Tools</b> → Add new MCP server，名称填 <code>serial-protocol-manager</code>，类型 stdio，命令 <code>node</code>，参数为上方 mcp-server.js 路径'],
        code: '',
      },
    ],
  },
  {
    id: 'vscode', name: 'VS Code', color: '#007ACC', monogram: 'VS',
    blocks: [
      {
        title: '配置文件（顶层键为 servers）',
        steps: [
          '工作区根目录新建 <code>.vscode/mcp.json</code>（或命令面板运行 “MCP: Open User Configuration” 建全局配置）',
          '加入如下内容后保存。注意 VS Code 的顶层键是 <code>servers</code>，与其他客户端不同',
          '需启用 GitHub Copilot 扩展，Copilot Chat 的工具列表可见即成功',
        ],
        code: vscodeJson.value,
      },
    ],
  },
  {
    id: 'cline', name: 'CLine', color: '#6B4FBB', monogram: 'CL',
    blocks: [
      {
        title: '修改 cline_mcp_settings.json',
        steps: [
          'VS Code 打开 CLine 侧边栏 → 顶部 <b>MCP Servers</b> 图标 → Configure MCP',
          '在打开的 <code>cline_mcp_settings.json</code> 中加入如下内容，保存后自动重连（绿点即在线）',
        ],
        code: stdioJson.value,
      },
    ],
  },
  {
    id: 'zcode', name: 'ZCode', color: '#0E7490', monogram: 'ZC',
    blocks: [
      {
        title: '修改 mcpServers 配置',
        steps: [
          '在 ZCode 的 MCP 服务器配置（mcpServers 段，可参考其文档的接入入口）中加入如下内容',
          '保存后重启/重载会话即可看到 serial-protocol-manager 的 18 个工具',
        ],
        code: stdioJson.value,
      },
    ],
  },
  {
    id: 'generic', name: '… 其他', color: '#6B7280', monogram: '⋯',
    blocks: [
      {
        title: '通用配置',
        steps: [
          '任何支持 MCP（stdio 传输）的客户端都使用同一份 <code>mcpServers</code> JSON，加入其配置文件即可',
          '数据目录探测失败（提示“未找到应用数据目录”）时，在 args 后追加 <code>"--data-dir=<数据库所在目录>"</code>',
        ],
        code: stdioJson.value,
      },
      {
        title: '环境要求',
        steps: [
          '离线只读模式需要 Node.js ≥ 22.13（在线模式由桌面应用代跑，无版本要求）',
          '写操作（串口收发/备份/发布）会先在桌面应用内弹窗人工确认，30 秒未响应自动拒绝',
        ],
        code: '',
      },
    ],
  },
]);

const activeId = ref('claude-desktop');
const active = computed(() => clients.value.find((c) => c.id === activeId.value) || clients.value[0]);

/* 复制（file:// 下剪贴板 API 可能不可用，走 execCommand 兜底） */
const copiedKey = ref('');
let copyTimer = null;
async function copyCode(block) {
  let done = false;
  try {
    await navigator.clipboard.writeText(block.code);
    done = true;
  } catch { /* 兜底 */ }
  if (!done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = block.code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      done = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { done = false; }
  }
  if (done) {
    copiedKey.value = block.title;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedKey.value = ''; }, 2000);
  }
}

function openTutorial() {
  if (window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal('https://github.com/ALVAN-1/BaudLab.io');
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  if (hasElectron && window.electronAPI.app?.getMcpInfo) {
    window.electronAPI.app.getMcpInfo()
      .then((info) => { if (info?.serverPath) serverPath.value = info.serverPath; })
      .catch(() => { /* 保持占位路径 */ });
  }
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<style scoped>
.mcp-guide-overlay { z-index: 300; }
.mcp-guide-dialog {
  display: flex;
  flex-direction: column;
  width: 780px;
  max-width: calc(100vw - 80px);
  height: 540px;
  max-height: calc(100vh - 80px);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg, 0 20px 60px rgba(0, 0, 0, 0.35));
  overflow: hidden;
}
.mcp-guide-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.mcp-guide-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
.mcp-guide-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary); cursor: pointer;
}
.mcp-guide-close:hover { background: var(--bg-hover); color: var(--text-primary); }

.mcp-guide-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.mcp-guide-nav {
  width: 168px;
  flex-shrink: 0;
  padding: 10px 8px;
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-tertiary);
}
.mcp-guide-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}
.mcp-guide-nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.mcp-guide-nav-item.on { background: var(--bg-elevated); color: var(--text-primary); font-weight: 500; }
.mcp-guide-nav-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; flex-shrink: 0;
  border-radius: 6px;
  color: #fff;
  font-size: 10px; font-weight: 700; letter-spacing: 0.2px;
}

.mcp-guide-content {
  flex: 1;
  min-width: 0;
  padding: 18px 22px;
  overflow-y: auto;
}
.mcp-guide-manual-title { font-size: 13px; font-weight: 600; color: var(--text-tertiary); margin-bottom: 14px; }
.mcp-guide-method { font-size: 13.5px; font-weight: 600; color: var(--text-primary); margin: 14px 0 8px; }
.mcp-guide-content > .mcp-guide-method:first-of-type { margin-top: 0; }
.mcp-guide-steps {
  margin: 0 0 10px;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-secondary);
}
.mcp-guide-steps code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 11.5px;
  color: var(--accent-amber);
}
.mcp-guide-steps b { color: var(--text-primary); font-weight: 600; }

.mcp-guide-code-wrap { position: relative; margin: 0 0 6px; }
.mcp-guide-code {
  margin: 0;
  padding: 12px 40px 12px 14px;
  border-radius: 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  cursor: text;
}
.mcp-guide-copy {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
}
.mcp-guide-copy:hover { color: var(--text-primary); border-color: var(--text-muted); }

.mcp-guide-note {
  display: flex;
  gap: 6px;
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px dashed var(--border-color);
  font-size: 12px;
  line-height: 1.6;
  color: var(--accent-amber);
  opacity: 0.9;
}

.mcp-guide-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}
.mcp-guide-link {
  font-size: 12.5px;
  color: var(--accent-amber);
  cursor: pointer;
}
.mcp-guide-link:hover { text-decoration: underline; }
.mcp-guide-done { min-width: 76px; }
</style>
