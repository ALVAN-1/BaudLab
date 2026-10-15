const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ---------------------------------------------------------------------------
// 安全暴露 API 给渲染进程
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('electronAPI', {
  // --- 串口 ---
  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (options) => ipcRenderer.invoke('serial:open', options),
    close: (portPath) => ipcRenderer.invoke('serial:close', portPath),
    send: (params) => ipcRenderer.invoke('serial:send', params),
    active: () => ipcRenderer.invoke('serial:active'),
    onData: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('serial:data', handler);
      return () => ipcRenderer.removeListener('serial:data', handler);
    },
    onError: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('serial:error', handler);
      return () => ipcRenderer.removeListener('serial:error', handler);
    },
    onPortsChanged: (callback) => {
      const handler = (event, ports) => callback(ports);
      ipcRenderer.on('serial:ports-changed', handler);
      return () => ipcRenderer.removeListener('serial:ports-changed', handler);
    },
    // --- MCP 串口活动镜像（外部 AI 客户端的打开/发送/关闭实时同步到调试页） ---
    getMcpPorts: () => ipcRenderer.invoke('serial:mcp-ports'),
    onMcpOpened: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('serial:mcp-opened', handler);
      return () => ipcRenderer.removeListener('serial:mcp-opened', handler);
    },
    onMcpClosed: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('serial:mcp-closed', handler);
      return () => ipcRenderer.removeListener('serial:mcp-closed', handler);
    },
    onMcpTx: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('serial:mcp-tx', handler);
      return () => ipcRenderer.removeListener('serial:mcp-tx', handler);
    }
  },

  // --- 文件传输（文件发送模块） ---
  fileTransfer: {
    pickFile: () => ipcRenderer.invoke('fileTransfer:pickFile'),
    readFile: (filePath) => ipcRenderer.invoke('fileTransfer:readFile', filePath),
    /* 拖拽文件 → 绝对路径（Electron 32 起 File.path 被移除，统一走 webUtils） */
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return (file && file.path) ? file.path : '';
      }
    },
  },

  // --- 用户认证（邮箱注册/登录/找回 + 会话恢复 + 本地身份） ---
  auth: {
    listUsers: (params) => ipcRenderer.invoke('auth:list-users', params),
    getSession: () => ipcRenderer.invoke('auth:get-session'),
    localEnter: (params) => ipcRenderer.invoke('auth:local-enter', params),
    login: (params) => ipcRenderer.invoke('auth:login', params),
    registerRequest: (params) => ipcRenderer.invoke('auth:register-request', params),
    registerVerify: (params) => ipcRenderer.invoke('auth:register-verify', params),
    forgotRequest: (params) => ipcRenderer.invoke('auth:forgot-request', params),
    resetPassword: (params) => ipcRenderer.invoke('auth:reset-password', params),
    changePassword: (params) => ipcRenderer.invoke('auth:change-password', params),
    logout: () => ipcRenderer.invoke('auth:logout')
  },

  // --- 数据库 ---
  db: {
    query: (sql, params) => ipcRenderer.invoke('db:query', { sql, params }),
    execute: (sql, params) => ipcRenderer.invoke('db:execute', { sql, params }),
    batch: (statements) => ipcRenderer.invoke('db:batch', statements),
    backup: () => ipcRenderer.invoke('db:backup'),
    stats: () => ipcRenderer.invoke('db:stats'),
    backupList: () => ipcRenderer.invoke('db:backup-list'),
    integrityCheck: () => ipcRenderer.invoke('db:integrity-check')
  },

  // --- 数据/数据库保存目录（更新时可浏览切换，重启后生效） ---
  dataDir: {
    get: () => ipcRenderer.invoke('data-dir:get'),
    choose: () => ipcRenderer.invoke('data-dir:choose'),
    set: (dir) => ipcRenderer.invoke('data-dir:set', dir),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
  },

  // --- 协议草稿（远程模式下本地暂存，审核通过后发布） ---
  draft: {
    save: (statements, protoName) => ipcRenderer.invoke('draft:save', { statements, protoName }),
    list: () => ipcRenderer.invoke('draft:list'),
    get: (name) => ipcRenderer.invoke('draft:get', name),
    delete: (name) => ipcRenderer.invoke('draft:delete', name),
    publish: (name) => ipcRenderer.invoke('draft:publish', name),
  },

  // --- 系统日志 ---
  logs: {
    get: (limit = 100, offset = 0) => ipcRenderer.invoke('logs:get', limit, offset),
    clear: () => ipcRenderer.invoke('logs:clear')
  },

  // --- 窗口控制 ---
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized')
  },

  // --- 主题 ---
  theme: {
    set: (theme) => ipcRenderer.invoke('theme:set', theme)
  },

  // --- 应用信息 ---
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    getLoginItemSettings: () => ipcRenderer.invoke('app:get-login-item-settings'),
    setLoginItemSettings: (opts) => ipcRenderer.invoke('app:set-login-item-settings', opts),
    setUpdateNotify: (enabled) => ipcRenderer.invoke('app:set-update-notify', enabled),
    showNotification: (title, body) => ipcRenderer.invoke('app:show-notification', { title, body }),
    getMcpInfo: () => ipcRenderer.invoke('app:mcp-info'),
    getMcpPolicies: () => ipcRenderer.invoke('app:mcp-policies'),
    resetMcpPolicy: (key) => ipcRenderer.invoke('app:mcp-policy-reset', key),
  },

  // --- MCP 确认弹窗（渲染层自绘；主进程发起请求，渲染层回传结果） ---
  mcpConfirm: {
    onRequest: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('mcp:confirm-request', handler);
      return () => ipcRenderer.removeListener('mcp:confirm-request', handler);
    },
    respond: (payload) => ipcRenderer.invoke('mcp:confirm-response', payload),
  },

  // --- README 帮助文档 ---
  readme: {
    get: () => ipcRenderer.invoke('app:readme'),
  },

  // --- 打开外部链接 ---
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // --- 反馈问题直接提交 GitHub Issue（token 存主进程，渲染层只传内容） ---
  feedback: {
    submitIssue: (data) => ipcRenderer.invoke('feedback:submit-issue', data),
    getTokenStatus: () => ipcRenderer.invoke('github-token:get'),
    setToken: (token) => ipcRenderer.invoke('github-token:set', token),
  },

  // --- AI 助手（OpenAI 协议兼容，Key/配置存主进程，渲染层只传对话内容） ---
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:get-config'),
    setConfig: (cfg) => ipcRenderer.invoke('ai:set-config', cfg),
    test: () => ipcRenderer.invoke('ai:test'),
    listModels: () => ipcRenderer.invoke('ai:list-models'),
    send: (params) => ipcRenderer.invoke('ai:send', params),
    generateJson: (params) => ipcRenderer.invoke('ai:generate-json', params),
    abort: () => ipcRenderer.invoke('ai:abort'),
    onChunk: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('ai:chunk', handler);
      return () => ipcRenderer.removeListener('ai:chunk', handler);
    },
    onTool: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('ai:tool', handler);
      return () => ipcRenderer.removeListener('ai:tool', handler);
    },
    onDone: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('ai:done', handler);
      return () => ipcRenderer.removeListener('ai:done', handler);
    },
    onError: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('ai:error', handler);
      return () => ipcRenderer.removeListener('ai:error', handler);
    },
  },

  // --- 自动更新 ---
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onError: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('update:error', handler);
      return () => ipcRenderer.removeListener('update:error', handler);
    },
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('update:progress', handler);
      return () => ipcRenderer.removeListener('update:progress', handler);
    },
    onDownloaded: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('update:downloaded', handler);
      return () => ipcRenderer.removeListener('update:downloaded', handler);
    },
    onAvailable: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('update:available', handler);
      return () => ipcRenderer.removeListener('update:available', handler);
    },
    onShowAvailable: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('update:show-available', handler);
      return () => ipcRenderer.removeListener('update:show-available', handler);
    },
  },

  // --- 协议导出 ---
  export: {
    saveFile: (params) => ipcRenderer.invoke('export:saveFile', params)
  },

  // --- 协议导入 ---
  import: {
    openFile: () => ipcRenderer.invoke('import:openFile')
  },

  // --- 数据源配置（本地 SQLite / 团队服务器） ---
  dbConfig: {
    get: () => ipcRenderer.invoke('db-config:get'),
    set: (cfg) => ipcRenderer.invoke('db-config:set', cfg),
    test: (cfg) => ipcRenderer.invoke('db-config:test', cfg),
    fallbackLocal: () => ipcRenderer.invoke('db-config:fallback-local'),
    restoreRemote: () => ipcRenderer.invoke('db-config:restore-remote')
  },
  offlineMark: {
    get: () => ipcRenderer.invoke('offline-mark:get'),
    clear: () => ipcRenderer.invoke('offline-mark:clear'),
    update: (keepTables) => ipcRenderer.invoke('offline-mark:update', keepTables)
  },

  // --- 离线修改同步（读取本地库数据供差异比对） ---
  sync: {
    readLocal: () => ipcRenderer.invoke('sync:read-local')
  },

  // --- 用户在线状态 ---
  heartbeat: {
    start: (username) => ipcRenderer.invoke('heartbeat:start', username),
    stop: () => ipcRenderer.invoke('heartbeat:stop'),
  },
  onlineUsers: {
    get: () => ipcRenderer.invoke('online-users:get'),
  },

  // --- 内嵌团队服务器（客户端「作为局域网主机」） ---
  teamServer: {
    status: () => ipcRenderer.invoke('team-server:status'),
    // 数据目录：创建团队时先弹窗让用户浏览选路径，再启动服务端
    dataRoot: () => ipcRenderer.invoke('team-server:data-root'),
    chooseDataRoot: () => ipcRenderer.invoke('team-server:choose-data-root'),
    setDataRoot: (dir) => ipcRenderer.invoke('team-server:set-data-root', dir),
    start: (opts) => ipcRenderer.invoke('team-server:start', opts),
    stop: () => ipcRenderer.invoke('team-server:stop'),
    restart: () => ipcRenderer.invoke('team-server:restart'),
    getConfig: () => ipcRenderer.invoke('team-server:get-config'),
    setConfig: (patch) => ipcRenderer.invoke('team-server:set-config', patch),
    regenerateToken: () => ipcRenderer.invoke('team-server:regen-token'),
    openAdmin: () => ipcRenderer.invoke('team-server:open-admin'),
    onState: (callback) => {
      const handler = (event, state) => callback(state);
      ipcRenderer.on('team-server:state', handler);
      return () => ipcRenderer.removeListener('team-server:state', handler);
    },
    onLog: (callback) => {
      const handler = (event, payload) => callback(payload);
      ipcRenderer.on('team-server:log', handler);
      return () => ipcRenderer.removeListener('team-server:log', handler);
    },
    // 本机管理接口：在客户端内直接管理团队成员账号（免邮箱验证）
    admin: {
      listUsers: () => ipcRenderer.invoke('team-server:admin-users'),
      createUser: (payload) => ipcRenderer.invoke('team-server:admin-create-user', payload),
      setUserRole: (payload) => ipcRenderer.invoke('team-server:admin-set-role', payload),
      setUserStatus: (payload) => ipcRenderer.invoke('team-server:admin-set-status', payload),
      deleteUser: (payload) => ipcRenderer.invoke('team-server:admin-delete-user', payload),
    },
  },

  // --- 局域网零配置发现（mDNS） ---
  discovery: {
    start: () => ipcRenderer.invoke('discovery:start'),
    stop: () => ipcRenderer.invoke('discovery:stop'),
    list: () => ipcRenderer.invoke('discovery:list'),
    onUpdate: (callback) => {
      const handler = (event, list) => callback(list);
      ipcRenderer.on('discovery:update', handler);
      return () => ipcRenderer.removeListener('discovery:update', handler);
    },
  }
});
