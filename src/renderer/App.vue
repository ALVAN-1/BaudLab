<template>
  <!-- 窗口标题栏（始终显示，覆盖登录界面） -->
  <header class="titlebar" @dblclick="onTitlebarDblClick">
    <div class="titlebar-left">
      <div class="app-logo">
        <img :src="iconUrl" alt="logo" style="width:100%;height:100%;border-radius:6px;" />
      </div>
      <span class="app-name">BaudLab</span>
      <span class="app-version">v{{ appVersion }}</span>
      <!-- 数据源状态徽章：点击进入系统设置修改 -->
      <button class="titlebar-pill" :class="{ warn: offlineSession }" :title="serverPillTitle" @click="goToDbSettings">
        <span class="pill-dot" :class="{ on: dbEffective === 'remote' && !offlineSession, warn: offlineSession }"></span>
        <span>{{ serverPillText }}</span>
      </button>
      <!-- MCP 接入状态徽章：点击查看配置指南 -->
      <button class="titlebar-pill" :title="mcpReady ? `MCP 桥在线（127.0.0.1:${mcpBridgePort}），点击查看配置指南` : 'MCP 桥未就绪，点击查看配置指南'" @click="showMcpGuide = true">
        <span class="pill-dot" :class="{ on: mcpReady }"></span>
        <span>MCP {{ mcpReady ? '已启用' : '未启用' }}</span>
      </button>
    </div>
    <div class="titlebar-actions">
      <button class="titlebar-btn" title="最小化" @click="onWindowAction('minimize')">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-window-minimize"/></svg>
      </button>
      <button class="titlebar-btn" title="最大化" @click="onWindowAction('maximize')">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-window-maximize"/></svg>
      </button>
      <button class="titlebar-btn close" title="关闭" @click="onWindowAction('close')">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-close"/></svg>
      </button>
    </div>
  </header>

  <!-- 用户选择弹窗 -->
  <Transition name="modal-fade">
    <div v-if="showLogin" class="login-overlay">
      <!-- 选中「创建团队」时先弹窗问数据目录：团队数据库/配置/备份存哪儿由用户浏览决定。
           必须放在 .login-overlay 内（与 .login-dialog 同级）：主界面 .app-window 在
           登录期是 v-show 隐藏的，挂在那里弹窗永远出不来。 -->
      <Transition name="modal-fade">
        <div v-if="showTeamDirDialog" class="modal-overlay" @click.self="closeTeamDirDialog">
          <div class="modal-dialog" style="max-width:460px;">
            <div class="modal-header">
              <h3>选择团队服务器数据目录</h3>
            </div>
            <div class="modal-body">
              <p style="color:var(--text-secondary);line-height:1.6;font-size:13px;margin:0 0 12px;">
                本机将作为团队服务器运行，团队数据库、服务端配置与备份都会保存在这个文件夹里。<br>
                默认在应用数据目录下，可浏览改为自定义位置。
              </p>
              <div class="dirpick-row">
                <input
                  v-model="teamDirForm.path"
                  class="dirpick-input"
                  type="text"
                  spellcheck="false"
                  placeholder="选择团队数据保存的文件夹"
                  @keyup.enter="confirmCreateTeam"
                />
                <button type="button" class="dirpick-btn" :disabled="teamDirForm.busy" @click="browseTeamDir">浏览</button>
              </div>
              <div
                class="dirpick-hint"
                style="margin-top:8px;"
                :class="{ ok: teamDirForm.ok, err: teamDirForm.err }"
              >{{ teamDirForm.hint }}</div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" :disabled="teamDirForm.busy" @click="closeTeamDirDialog">取消</button>
              <button
                class="btn btn-primary"
                :disabled="teamDirForm.busy || !teamDirForm.path.trim()"
                @click="confirmCreateTeam"
              >{{ teamDirForm.busy ? '处理中…' : '创建团队' }}</button>
            </div>
          </div>
        </div>
      </Transition>
      <div class="login-dialog" :class="{ 'dialog-wide': chooserVisible }">
        <div class="login-header">
          <!-- 二级页（创建管理员账号）右上角返回：回到「选择使用方式」 -->
          <button
            v-if="needFirstAdmin"
            type="button"
            class="login-back-btn"
            title="返回选择使用方式"
            @click="backToChooser"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M19 12H5"/>
              <path d="m12 19-7-7 7-7"/>
            </svg>
            <span>返回</span>
          </button>
          <!-- 贪吃蛇 logo：蛇沿方波爬向白点并吃掉，无限循环（busy 加速，成功弹跳）
               动画在文件底部 <style> 块（Vue 编译）里定义，避免 SVG 内 <style> 被剥离 -->
          <div class="login-logo" :class="{ busy: authBusy, success: authSuccess }">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true">
              <defs>
                <linearGradient id="loginBg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#16203A"/>
                  <stop offset="1" stop-color="#0A0F1C"/>
                </linearGradient>
                <linearGradient id="loginWave" x1="0" y1="1" x2="1" y2="0">
                  <stop offset="0" stop-color="#FF8A3D"/>
                  <stop offset="1" stop-color="#FF6A00"/>
                </linearGradient>
              </defs>
              <rect x="48" y="48" width="928" height="928" rx="210" fill="url(#loginBg)"/>
              <rect x="50" y="50" width="924" height="924" rx="208" fill="none" stroke="#2A3A5C" stroke-width="4"/>
              <!-- 蛇（方波）——真实路径像素长度 = 220+212+200+168+260 = 1060，
                   与 stroke-dasharray 用的值完全一致，因此不用 pathLength 属性，
                   避免 Chromium 中 pathLength 与 CSS 动画 dashoffset 的交互 bug。 -->
              <path
                class="s-snake"
                d="M232 672 H452 V460 H652 V292 H912"
                fill="none" stroke="url(#loginWave)" stroke-width="92"
                stroke-linecap="round" stroke-linejoin="round"
              />
              <!-- 白色食物点 -->
              <circle class="s-dot" cx="912" cy="292" r="44" fill="#FFFFFF"/>
            </svg>
          </div>
          <FireworksGreeting />
          <p>{{ loginSubtitle }}</p>
        </div>
        <div class="login-body">
          <!-- 服务器不可达：保留会话文件，恢复后自动续上 -->
          <div v-if="sessionState === 'unreachable'" class="login-server-tip">
            <div class="user-empty-state" style="padding:6px 0 2px;">
              <div class="user-empty-icon" style="background:rgba(239,68,68,0.12);color:var(--accent-red);">
                <svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m2 2 20 20"/>
                  <path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/>
                  <path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>
                </svg>
              </div>
              <div class="user-empty-title">无法连接团队服务器</div>
              <div class="user-empty-desc" style="text-align:center;line-height:1.5;">{{ sessionError }}</div>
            </div>
            <p class="login-server-hint">
              可能原因：主机电脑未开机或未启动服务器，也可能是地址/访问令牌有误。<br>
              若这是你的第一台设备，可把本机直接设为团队服务器。
            </p>
            <p v-if="unreachableAutoRetrying" class="login-server-hint" style="color:var(--accent-blue);">
              正在自动重试连接服务器…
            </p>
            <div class="login-form-actions">
              <button class="btn btn-secondary" :disabled="authBusy" @click="retrySession">{{ authBusy ? '重试中…' : '重试' }}</button>
              <button class="btn btn-secondary" :disabled="hostBusy || authBusy" @click="becomeHostAndConnect">{{ hostBusy ? '启动中…' : '把本机设为团队服务器' }}</button>
              <button class="btn btn-primary login-confirm-btn" :disabled="authBusy" @click="enterLocalMode">{{ authBusy ? '进入中…' : '进入本地模式' }}</button>
            </div>
          </div>

          <!-- 本地模式：无需服务器，选择/添加本机身份（数据保存在本机 SQLite） -->
          <div v-else-if="loginView === 'local'" class="login-form">
            <template v-if="!localAddMode">
              <div v-if="localUsers.length === 0 && !localListError" class="user-empty-state" style="padding:14px 0 10px;">
                <div class="user-empty-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <line x1="19" y1="8" x2="19" y2="14"/>
                    <line x1="22" y1="11" x2="16" y2="11"/>
                  </svg>
                </div>
                <div class="user-empty-title">还没有本地身份</div>
                <div class="user-empty-desc" style="text-align:center;line-height:1.5;">添加一个本地身份即可在本机使用<br>数据保存在本机，不会上传团队服务器</div>
              </div>
              <div v-else-if="localUsers.length === 0 && localListError" class="user-empty-state" style="padding:14px 0 10px;">
                <div class="user-empty-icon" style="background:rgba(239,68,68,0.12);color:var(--accent-red);">
                  <svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                </div>
                <div class="user-empty-title">本地身份列表加载失败</div>
                <div class="user-empty-desc" style="text-align:center;line-height:1.5;">{{ localListError }}</div>
              </div>
              <template v-else>
                <div class="user-select-list">
                  <div
                    v-for="u in localUsers"
                    :key="u.id"
                    class="user-select-card"
                    @click="doLocalSelect(u)"
                  >
                    <div class="user-select-avatar">{{ (u.name || 'U').slice(0, 2).toUpperCase() }}</div>
                    <div class="user-select-info">
                      <div class="user-select-name">{{ u.name }}</div>
                      <div class="user-select-meta">
                        <span v-if="u.project">{{ u.project }}</span>
                        <span v-if="u.module"> · {{ u.module }}</span>
                        <span v-if="u.role" class="user-select-role">{{ u.role }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
              <span v-if="loginError" class="login-error">{{ loginError }}</span>
              <div class="login-form-actions">
                <button class="btn btn-secondary" @click="switchLoginView('login')">返回</button>
                <button class="btn btn-primary login-confirm-btn" :disabled="localListBusy" @click="localAddMode = true; loginError = ''">
                  {{ localUsers.length === 0 ? '添加第一个本地身份' : '+ 添加本地身份' }}
                </button>
              </div>
            </template>
            <template v-else>
              <div class="login-form-row">
                <label class="login-form-label">用户名 <span class="login-required">*</span></label>
                <input type="text" class="input login-form-input" v-model="localAddForm.username" placeholder="请输入用户名" @keyup.enter="doLocalAddUser" />
              </div>
              <div class="login-form-row">
                <label class="login-form-label">项目</label>
                <input type="text" class="input login-form-input" v-model="localAddForm.project" placeholder="所属项目（选填）" />
              </div>
              <div class="login-form-row">
                <label class="login-form-label">负责模块</label>
                <input type="text" class="input login-form-input" v-model="localAddForm.module" placeholder="负责模块（选填）" @keyup.enter="doLocalAddUser" />
              </div>
              <span v-if="loginError" class="login-error">{{ loginError }}</span>
              <div class="login-form-actions">
                <button class="btn btn-secondary" @click="localAddMode = false; loginError = ''">返回</button>
                <button class="btn btn-primary login-confirm-btn" :disabled="!canLocalAdd || authBusy" @click="doLocalAddUser">
                  {{ authBusy ? '添加中…' : '添加并进入' }}
                </button>
              </div>
            </template>
          </div>

          <!-- 使用方式引导：单机 / 加入团队 / 创建团队（启动无有效会话时先出此页） -->
          <div v-else-if="chooserVisible" class="login-form">
            <div class="user-empty-state" style="padding:4px 0 10px;">
              <div class="user-empty-title">选择使用方式</div>
              <div class="user-empty-desc" style="text-align:center;line-height:1.5;">
                团队模式下协议、账号与审核数据由一台电脑统一提供，成员实时共享；<br>单机模式数据只保存在本机
              </div>
            </div>

            <div class="team-choice">
              <button v-if="serverReady && serverForm.url" type="button" class="team-choice-card continue" @click="continueConfiguredMode">
                <span class="team-choice-icon" aria-hidden="true">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-monitor"/></svg>
                </span>
                <span class="team-choice-title">继续使用团队服务器</span>
                <span class="team-choice-desc">{{ serverForm.url }}<template v-if="sessionState === 'unreachable'">（当前不可达）</template></span>
              </button>
              <button type="button" class="team-choice-card" :class="{ active: showJoinPanel }" @click="toggleJoinPanel">
                <span class="team-choice-icon" aria-hidden="true">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-users"/></svg>
                </span>
                <span class="team-choice-title">加入团队</span>
                <span class="team-choice-desc">扫描局域网或填写同事主机地址</span>
              </button>
              <button type="button" class="team-choice-card" :disabled="hostBusy || authBusy" @click="openTeamDirDialog">
                <span class="team-choice-icon" aria-hidden="true">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-plus"/></svg>
                </span>
                <span class="team-choice-title">{{ hostBusy ? '正在启动…' : '创建团队' }}</span>
                <span class="team-choice-desc">把本机作为服务器，无需额外安装</span>
              </button>
              <button type="button" class="team-choice-card" @click="switchLoginView('local')">
                <span class="team-choice-icon" aria-hidden="true">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-database"/></svg>
                </span>
                <span class="team-choice-title">单机使用</span>
                <span class="team-choice-desc">不联网，数据保存在本机</span>
              </button>
            </div>

            <template v-if="showJoinPanel">
              <div class="login-scan">
                <div class="login-scan-head">
                  <span>局域网发现的服务器</span>
                  <button type="button" class="btn-link" @click="toggleLoginScan">
                    {{ loginScanning ? '停止扫描' : '扫描' }}
                  </button>
                </div>
                <div v-if="loginScanList.length === 0" class="login-scan-empty">
                  {{ loginScanning ? '搜索中…' : '未发现服务器，可手动填写地址' }}
                </div>
                <ul v-else class="login-scan-list">
                  <li
                    v-for="d in loginScanList"
                    :key="d.url"
                    :class="{ active: serverForm.url === d.url }"
                    @click="applyLoginServer(d)"
                  >
                    <span class="login-scan-name">{{ d.name }}</span>
                    <span class="login-scan-url">{{ d.url }}</span>
                  </li>
                </ul>
              </div>
              <div class="login-form-row">
                <label class="login-form-label">服务器地址 <span class="login-required">*</span></label>
                <input type="text" class="input login-form-input" v-model="serverForm.url" placeholder="http://192.168.x.x:3010" @keyup.enter="doConnectServer" />
              </div>
              <div class="login-form-row">
                <label class="login-form-label">访问令牌</label>
                <input type="password" class="input login-form-input" v-model="serverForm.token" placeholder="主机提供的访问令牌" @keyup.enter="doConnectServer" />
              </div>
              <span v-if="loginError" class="login-error">{{ loginError }}</span>
              <div class="login-form-actions">
                <button class="btn btn-secondary" :disabled="authBusy" @click="retrySession">重新检测</button>
                <button class="btn btn-primary login-confirm-btn" :disabled="!serverForm.url || authBusy" @click="doConnectServer">
                  {{ authBusy ? '连接中…' : '连接并继续' }}
                </button>
              </div>
            </template>
          </div>

          <!-- 首个管理员：本机作为主机后可直接免邮箱创建，无需配置 SMTP -->
          <div v-else-if="needFirstAdmin" class="login-form">
            <div class="user-empty-state" style="padding:4px 0 10px;">
              <div class="user-empty-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <path d="m9 12 2 2 4-4"/>
                </svg>
              </div>
              <div class="user-empty-title">创建管理员账号</div>
              <div class="user-empty-desc" style="text-align:center;line-height:1.5;">
                服务器已在本机启动，先创建一个管理员账号即可开始使用，<br>无需配置邮件发信
              </div>
            </div>
            <div class="login-form-row">
              <label class="login-form-label">管理员邮箱 <span class="login-required">*</span></label>
              <input type="email" class="input login-form-input" v-model="firstAdminForm.email" placeholder="name@company.com" @keyup.enter="createFirstAdmin" />
            </div>
            <div class="login-form-row">
              <label class="login-form-label">登录密码 <span class="login-required">*</span></label>
              <input type="password" class="input login-form-input" v-model="firstAdminForm.password" placeholder="至少 8 位" @keyup.enter="createFirstAdmin" />
            </div>
            <div class="login-form-row">
              <label class="login-form-label">显示名</label>
              <input type="text" class="input login-form-input" v-model="firstAdminForm.displayName" placeholder="审核与通知中显示的姓名（选填）" @keyup.enter="createFirstAdmin" />
            </div>
            <span v-if="firstAdminError" class="login-error">{{ firstAdminError }}</span>
            <div class="login-form-actions">
              <button class="btn btn-secondary" @click="needFirstAdmin = false">返回登录</button>
              <button class="btn btn-primary login-confirm-btn" :disabled="!canFirstAdmin || firstAdminBusy" @click="createFirstAdmin">
                {{ firstAdminBusy ? '创建中…' : '创建账号' }}
              </button>
            </div>
          </div>

          <!-- 登录 -->
          <div v-else-if="loginView === 'login'" class="login-form">
            <div class="login-form-row">
              <label class="login-form-label">邮箱 <span class="login-required">*</span></label>
              <input
                ref="loginEmailEl"
                type="email"
                class="input login-form-input"
                v-model="loginForm.email"
                placeholder="name@company.com"
                autocomplete="username"
                @input="loginSuggest.onInput"
                @keydown="loginSuggest.onKeydown"
                @blur="loginSuggest.dismiss"
                @keyup.enter="onLoginEnter"
              />
              <Teleport to="body">
                <ul v-if="loginSuggest.open" class="email-suggest-pop" :style="loginSuggest.popStyle" role="listbox" aria-label="常用邮箱后缀">
                  <li
                    v-for="(s, i) in loginSuggest.suggestions"
                    :key="s.domain"
                    class="email-suggest-item"
                    :class="{ active: i === loginSuggest.activeIndex }"
                    role="option"
                    :aria-selected="i === loginSuggest.activeIndex"
                    :title="s.local + '@' + s.domain"
                    @mousedown.prevent="loginSuggest.select(i)"
                    @mouseenter="loginSuggest.activeIndex = i"
                  >
                    <span class="es-local">{{ s.local }}@</span><span class="es-hit">{{ s.domain.slice(0, s.typed.length) }}</span>{{ s.domain.slice(s.typed.length) }}
                  </li>
                </ul>
              </Teleport>
            </div>
            <div class="login-form-row">
              <label class="login-form-label">密码 <span class="login-required">*</span></label>
              <div class="pwd-input-wrap">
                <input
                  :type="showLoginPassword ? 'text' : 'password'"
                  class="input login-form-input with-eye"
                  v-model="loginForm.password"
                  placeholder="请输入密码"
                  autocomplete="current-password"
                  @keyup.enter="doLogin"
                />
                <button
                  type="button"
                  class="pwd-eye-btn"
                  @click="showLoginPassword = !showLoginPassword"
                  :title="showLoginPassword ? '隐藏密码' : '显示密码'"
                  tabindex="-1"
                >
                  <svg v-if="showLoginPassword" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.17 4.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <span v-if="loginNotice" class="login-notice">{{ loginNotice }}</span>
            <span v-if="loginError" class="login-error">{{ loginError }}</span>
            <label class="login-remember" title="在本机加密保存密码，令牌过期后自动重新登录">
              <input type="checkbox" v-model="rememberPassword" />
              <span>记住密码</span>
            </label>
            <div class="login-form-actions">
              <button class="btn btn-primary login-confirm-btn" :disabled="!canLogin || authBusy" @click="doLogin">
                {{ authBusy ? '登录中…' : '登录' }}
              </button>
            </div>
            <div class="login-links">
              <button type="button" class="login-link-btn" @click="switchLoginView('register')">注册账号</button>
              <span class="login-link-sep">·</span>
              <button type="button" class="login-link-btn" @click="switchLoginView('forgot')">忘记密码</button>
              <span class="login-link-sep">·</span>
              <button type="button" class="login-link-btn" @click="switchLoginView('local')">本地模式</button>
            </div>
          </div>

          <!-- 注册（两步：邮箱验证码 → 设置密码） -->
          <div v-else-if="loginView === 'register'" class="login-form">
            <template v-if="registerStep === 1">
              <div class="login-form-row">
                <label class="login-form-label">邮箱 <span class="login-required">*</span></label>
                <input
                  ref="registerEmailEl"
                  type="email"
                  class="input login-form-input"
                  v-model="registerForm.email"
                  placeholder="name@company.com"
                  autocomplete="email"
                  @input="registerSuggest.onInput"
                  @keydown="registerSuggest.onKeydown"
                  @blur="registerSuggest.dismiss"
                  @keyup.enter="onRegisterEnter"
                />
                <Teleport to="body">
                  <ul v-if="registerSuggest.open" class="email-suggest-pop" :style="registerSuggest.popStyle" role="listbox" aria-label="常用邮箱后缀">
                    <li
                      v-for="(s, i) in registerSuggest.suggestions"
                      :key="s.domain"
                      class="email-suggest-item"
                      :class="{ active: i === registerSuggest.activeIndex }"
                      role="option"
                      :aria-selected="i === registerSuggest.activeIndex"
                      :title="s.local + '@' + s.domain"
                      @mousedown.prevent="registerSuggest.select(i)"
                      @mouseenter="registerSuggest.activeIndex = i"
                    >
                      <span class="es-local">{{ s.local }}@</span><span class="es-hit">{{ s.domain.slice(0, s.typed.length) }}</span>{{ s.domain.slice(s.typed.length) }}
                    </li>
                  </ul>
                </Teleport>
              </div>
              <span v-if="loginError" class="login-error">{{ loginError }}</span>
              <div class="login-form-actions">
                <button class="btn btn-secondary" @click="switchLoginView('login')">返回</button>
                <button class="btn btn-primary login-confirm-btn" :disabled="!registerForm.email || authBusy" @click="doRegisterRequest(false)">
                  {{ authBusy ? '发送中…' : '发送验证码' }}
                </button>
              </div>
            </template>
            <template v-else>
              <div class="login-form-row">
                <label class="login-form-label">验证码 <span class="login-required">*</span></label>
                <div class="code-row">
                  <input type="text" class="input login-form-input" v-model="registerForm.code" maxlength="6" inputmode="numeric" placeholder="6 位验证码" @keyup.enter="doRegisterVerify" />
                  <button type="button" class="btn btn-secondary resend-btn" :disabled="resendLeft > 0 || authBusy" @click="doRegisterRequest(true)">
                    {{ resendLeft > 0 ? resendLeft + 's 后重发' : '重新发送' }}
                  </button>
                </div>
              </div>
              <div class="login-form-row">
                <label class="login-form-label">设置密码 <span class="login-required">*</span></label>
                <div class="pwd-input-wrap">
                  <input
                    :type="showRegPassword ? 'text' : 'password'"
                    class="input login-form-input with-eye"
                    v-model="registerForm.password"
                    placeholder="至少 8 位"
                    autocomplete="new-password"
                    @keyup.enter="doRegisterVerify"
                  />
                  <button type="button" class="pwd-eye-btn" @click="showRegPassword = !showRegPassword" :title="showRegPassword ? '隐藏密码' : '显示密码'" tabindex="-1">
                    <svg v-if="showRegPassword" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.17 4.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                </div>
              </div>
              <div class="login-form-row">
                <label class="login-form-label">确认密码 <span class="login-required">*</span></label>
                <input type="password" class="input login-form-input" v-model="registerForm.confirmPassword" placeholder="再次输入密码" autocomplete="new-password" @keyup.enter="doRegisterVerify" />
              </div>
              <div class="login-form-row">
                <label class="login-form-label">显示名</label>
                <input type="text" class="input login-form-input" v-model="registerForm.displayName" placeholder="审核与通知中显示的姓名（选填）" @keyup.enter="doRegisterVerify" />
              </div>
              <span v-if="loginError" class="login-error">{{ loginError }}</span>
              <div class="login-form-actions">
                <button class="btn btn-secondary" @click="registerStep = 1; loginError = ''">返回</button>
                <button class="btn btn-primary login-confirm-btn" :disabled="!canRegisterVerify || authBusy" @click="doRegisterVerify">
                  {{ authBusy ? '提交中…' : '注册并进入' }}
                </button>
              </div>
            </template>
          </div>

          <!-- 忘记密码（两步：邮箱验证码 → 重置密码） -->
          <div v-else class="login-form">
            <template v-if="forgotStep === 1">
              <div class="login-form-row">
                <label class="login-form-label">注册邮箱 <span class="login-required">*</span></label>
                <input
                  ref="forgotEmailEl"
                  type="email"
                  class="input login-form-input"
                  v-model="forgotForm.email"
                  placeholder="name@company.com"
                  autocomplete="email"
                  @input="forgotSuggest.onInput"
                  @keydown="forgotSuggest.onKeydown"
                  @blur="forgotSuggest.dismiss"
                  @keyup.enter="onForgotEnter"
                />
                <Teleport to="body">
                  <ul v-if="forgotSuggest.open" class="email-suggest-pop" :style="forgotSuggest.popStyle" role="listbox" aria-label="常用邮箱后缀">
                    <li
                      v-for="(s, i) in forgotSuggest.suggestions"
                      :key="s.domain"
                      class="email-suggest-item"
                      :class="{ active: i === forgotSuggest.activeIndex }"
                      role="option"
                      :aria-selected="i === forgotSuggest.activeIndex"
                      :title="s.local + '@' + s.domain"
                      @mousedown.prevent="forgotSuggest.select(i)"
                      @mouseenter="forgotSuggest.activeIndex = i"
                    >
                      <span class="es-local">{{ s.local }}@</span><span class="es-hit">{{ s.domain.slice(0, s.typed.length) }}</span>{{ s.domain.slice(s.typed.length) }}
                    </li>
                  </ul>
                </Teleport>
              </div>
              <span v-if="loginError" class="login-error">{{ loginError }}</span>
              <div class="login-form-actions">
                <button class="btn btn-secondary" @click="switchLoginView('login')">返回</button>
                <button class="btn btn-primary login-confirm-btn" :disabled="!forgotForm.email || authBusy" @click="doForgotRequest(false)">
                  {{ authBusy ? '发送中…' : '发送验证码' }}
                </button>
              </div>
            </template>
            <template v-else>
              <div class="login-form-row">
                <label class="login-form-label">验证码 <span class="login-required">*</span></label>
                <div class="code-row">
                  <input type="text" class="input login-form-input" v-model="forgotForm.code" maxlength="6" inputmode="numeric" placeholder="6 位验证码" @keyup.enter="doForgotReset" />
                  <button type="button" class="btn btn-secondary resend-btn" :disabled="resendLeft > 0 || authBusy" @click="doForgotRequest(true)">
                    {{ resendLeft > 0 ? resendLeft + 's 后重发' : '重新发送' }}
                  </button>
                </div>
              </div>
              <div class="login-form-row">
                <label class="login-form-label">新密码 <span class="login-required">*</span></label>
                <div class="pwd-input-wrap">
                  <input
                    :type="showForgotPassword ? 'text' : 'password'"
                    class="input login-form-input with-eye"
                    v-model="forgotForm.password"
                    placeholder="至少 8 位"
                    autocomplete="new-password"
                    @keyup.enter="doForgotReset"
                  />
                  <button type="button" class="pwd-eye-btn" @click="showForgotPassword = !showForgotPassword" :title="showForgotPassword ? '隐藏密码' : '显示密码'" tabindex="-1">
                    <svg v-if="showForgotPassword" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.17 4.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                </div>
              </div>
              <div class="login-form-row">
                <label class="login-form-label">确认新密码 <span class="login-required">*</span></label>
                <input type="password" class="input login-form-input" v-model="forgotForm.confirmPassword" placeholder="再次输入新密码" autocomplete="new-password" @keyup.enter="doForgotReset" />
              </div>
              <span v-if="loginError" class="login-error">{{ loginError }}</span>
              <div class="login-form-actions">
                <button class="btn btn-secondary" @click="forgotStep = 1; loginError = ''">返回</button>
                <button class="btn btn-primary login-confirm-btn" :disabled="!canForgotReset || authBusy" @click="doForgotReset">
                  {{ authBusy ? '提交中…' : '重置密码' }}
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Transition>

  <div class="app-window" v-show="!showLogin">
    <div class="app-body">
      <!-- 侧边导航 -->
      <nav class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <div class="nav-section">
          <div class="nav-label-row">
            <div class="nav-label">工作区</div>
            <button class="sidebar-toggle" title="收起/展开侧边栏" @click="toggleSidebar">
              <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-collapse-left"/></svg>
            </button>
          </div>
          <button
            v-for="item in navItems"
            :key="item.view"
            class="nav-item"
            :class="{ active: currentView === item.view }"
            @click="switchView(item.view)"
          >
            <svg class="nav-icon" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use :href="'#' + item.iconRef"/></svg>
            <span class="nav-text">{{ item.text }}</span>
            <span v-if="item.badge" class="nav-badge" :class="item.badgeClass">{{ item.badge }}</span>
          </button>
        </div>
        <!-- 「数据库连接」已迁入系统设置（用户菜单 → 系统设置，或点击标题栏数据源徽章） -->
        <div class="sidebar-footer">
          <div class="user-mini" :class="{ active: userMenuOpen }" @click="toggleUserMenu">
            <div class="user-avatar">{{ userInitials }}</div>
            <div class="user-info">
              <span class="user-name">{{ userDisplayName }}</span>
              <span class="user-role">{{ userModuleText }}</span>
            </div>
            <svg class="user-arrow" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-chevron-down"/></svg>
          </div>
        </div>
      </nav>

      <!-- 用户菜单弹窗 -->
      <div
        class="user-menu-popup"
        :class="{ show: userMenuOpen }"
        :style="{ left: sidebarCollapsed ? '76px' : '252px' }"
        v-show="userMenuOpen"
        @click.stop
      >
        <div class="user-menu-header">
          <div class="user-avatar large">{{ userInitials }}</div>
          <div class="user-menu-info">
            <span class="user-menu-name">{{ userDisplayName }}</span>
            <span class="user-menu-role">{{ userModuleText }}</span>
            <span class="user-menu-email">{{ currentUser?.email || '—' }}</span>
          </div>
        </div>
        <div class="user-menu-section">
          <div class="user-menu-label">系统</div>
          <button class="user-menu-item" @click="checkUpdate">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-refresh-cw"/></svg>
            <span class="menu-item-text">{{ updateChecking ? '检查中...' : '检查版本更新' }}</span>
            <span class="menu-item-meta">v{{ appVersion }}</span>
          </button>
          <button class="user-menu-item" @click="showSystemLog = true; userMenuOpen = false;">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-file-text"/></svg>
            <span class="menu-item-text">系统日志</span>
          </button>
          <button class="user-menu-item" @click="switchView('settings'); userMenuOpen = false;">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-settings"/></svg>
            <span class="menu-item-text">系统设置</span>
          </button>
          <button class="user-menu-item" @click="openChangePassword">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-key"/></svg>
            <span class="menu-item-text">修改密码</span>
          </button>
          <div class="theme-switch-row">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use :href="isDarkMode ? '#i-moon' : '#i-sun'"/></svg>
            <span class="menu-item-text">{{ isDarkMode ? '深色模式' : '浅色模式' }}</span>
            <button class="theme-switch" :class="{ on: isDarkMode }" @click="toggleTheme">
              <span class="theme-switch-thumb"></span>
            </button>
          </div>
          <div class="theme-switch-row">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-serial"/></svg>
            <span class="menu-item-text">显示换行符</span>
            <button class="theme-switch" :class="{ on: showNewline }" @click="toggleShowNewline">
              <span class="theme-switch-thumb"></span>
            </button>
          </div>
        </div>
        <div class="user-menu-section">
          <div class="user-menu-label">支持</div>
          <button class="user-menu-item" @click="switchView('help'); userMenuOpen = false;">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-help-circle"/></svg>
            <span class="menu-item-text">帮助文档</span>
          </button>
          <button class="user-menu-item" @click="switchView('feedback'); userMenuOpen = false;">
            <svg class="menu-item-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-message-square"/></svg>
            <span class="menu-item-text">反馈问题</span>
          </button>
        </div>
        <div class="user-menu-footer">
          <button class="btn btn-secondary btn-small" @click="showLogoutDialog = true">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><use href="#i-log-out"/></svg>
            切换用户
          </button>
        </div>
      </div>

      <!-- 切换用户确认弹窗 -->
      <Transition name="modal-fade">
        <div v-if="showLogoutDialog" class="modal-overlay" @click.self="showLogoutDialog = false">
          <div class="modal-dialog logout-dialog">
            <div class="modal-header">
              <h3>切换用户</h3>
            </div>
            <div class="modal-body">
              <p style="color:var(--text-secondary);line-height:1.6;">确定要切换当前操作人员吗？<br>切换后将返回用户选择界面。</p>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" @click="showLogoutDialog = false">取消</button>
              <button class="btn btn-danger" @click="confirmLogout">确认切换</button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- MCP 写操作确认弹窗（主进程发起，自绘样式与应用一致） -->
      <Transition name="modal-fade">
        <div v-if="mcpConfirm.visible" class="modal-overlay" @click.self="respondMcpConfirm(false)">
          <div class="modal-dialog mcp-confirm-dialog">
            <div class="mcp-confirm-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>{{ mcpConfirm.title }}</span>
            </div>
            <h3 class="mcp-confirm-message">{{ mcpConfirm.message }}</h3>
            <div v-if="mcpConfirm.detail" class="mcp-confirm-detail">{{ mcpConfirm.detail }}</div>
            <label class="mcp-confirm-remember">
              <input type="checkbox" v-model="mcpConfirm.remember" />
              <span>{{ mcpConfirm.checkboxLabel }}</span>
            </label>
            <div class="modal-footer mcp-confirm-footer">
              <span class="mcp-confirm-hint">Enter 允许 · Esc 拒绝</span>
              <div class="mcp-confirm-actions">
                <button class="btn btn-secondary" @click="respondMcpConfirm(false)">拒绝</button>
                <button class="btn btn-primary mcp-confirm-allow" @click="respondMcpConfirm(true)">允许执行</button>
              </div>
            </div>
          </div>
        </div>
      </Transition>

      <!-- MCP 配置指南（点击标题栏 MCP 徽章弹出，各客户端接入指引） -->
      <McpGuideDialog v-if="showMcpGuide" @close="showMcpGuide = false" />

      <!-- 修改密码弹窗（所有用户自助） -->
      <Transition name="modal-fade">
        <div v-if="showChangePwdDialog" class="modal-overlay" @click.self="showChangePwdDialog = false">
          <div class="modal-dialog" style="width:380px;">
            <div class="modal-header">
              <h3>修改密码</h3>
            </div>
            <div class="modal-body">
              <div class="login-form" style="gap:12px;">
                <div class="login-form-row">
                  <label class="login-form-label">当前密码 <span class="login-required">*</span></label>
                  <div class="pwd-input-wrap">
                    <input :type="showChangeOldPwd ? 'text' : 'password'" class="input login-form-input with-eye" v-model="changePwdForm.oldPassword" placeholder="请输入当前密码" autocomplete="current-password" />
                    <button type="button" class="pwd-eye-btn" @click="showChangeOldPwd = !showChangeOldPwd" :title="showChangeOldPwd ? '隐藏密码' : '显示密码'" tabindex="-1">
                      <svg v-if="showChangeOldPwd" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.17 4.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                  </div>
                </div>
                <div class="login-form-row">
                  <label class="login-form-label">新密码 <span class="login-required">*</span></label>
                  <div class="pwd-input-wrap">
                    <input :type="showChangeNewPwd ? 'text' : 'password'" class="input login-form-input with-eye" v-model="changePwdForm.newPassword" placeholder="至少 8 位" autocomplete="new-password" />
                    <button type="button" class="pwd-eye-btn" @click="showChangeNewPwd = !showChangeNewPwd" :title="showChangeNewPwd ? '隐藏密码' : '显示密码'" tabindex="-1">
                      <svg v-if="showChangeNewPwd" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.17 4.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                  </div>
                </div>
                <div v-if="changePwdForm.newPassword" class="password-strength">
                  <div class="password-strength-bar">
                    <div class="password-strength-fill" :class="changePwdStrengthClass" :style="{ width: changePwdStrengthPercent + '%' }"></div>
                  </div>
                  <span class="password-strength-label" :class="changePwdStrengthClass">{{ changePwdStrengthLabel }}</span>
                </div>
                <div class="login-form-row">
                  <label class="login-form-label">确认新密码 <span class="login-required">*</span></label>
                  <div class="pwd-input-wrap">
                    <input :type="showChangeConfirmPwd ? 'text' : 'password'" class="input login-form-input with-eye" v-model="changePwdForm.confirmPassword" placeholder="再次输入新密码" autocomplete="new-password" @keyup.enter="doChangePassword" />
                    <button type="button" class="pwd-eye-btn" @click="showChangeConfirmPwd = !showChangeConfirmPwd" :title="showChangeConfirmPwd ? '隐藏密码' : '显示密码'" tabindex="-1">
                      <svg v-if="showChangeConfirmPwd" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.17 4.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                  </div>
                </div>
                <span v-if="changePwdError" class="login-error">{{ changePwdError }}</span>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" @click="showChangePwdDialog = false">取消</button>
              <button class="btn btn-primary" :disabled="!canChangePassword || changePwdBusy" @click="doChangePassword">
                {{ changePwdBusy ? '修改中…' : '确认修改' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 版本更新提示弹窗 -->
      <Transition name="modal-fade">
        <div v-if="showUpdateModal" class="modal-overlay" @click.self="showUpdateModal = false">
          <div class="modal-dialog" style="max-width:380px;">
            <div class="modal-header">
              <h3>版本检查</h3>
            </div>
            <div class="modal-body">
              <!-- 检查中 -->
              <div v-if="updateCheckResult.status === 'checking'" style="text-align:center;padding:10px 0;">
                <div style="width:40px;height:40px;border:3px solid var(--border-light);border-top-color:var(--accent-color);border-radius:50%;margin:0 auto 12px;animation:spin 0.8s linear infinite;"></div>
                <p style="color:var(--text-secondary);margin:0;">正在检查更新…</p>
              </div>

              <!-- 已是最新 -->
              <div v-else-if="updateCheckResult.status === 'latest'" style="text-align:center;padding:6px 0;">
                <div style="width:52px;height:52px;border-radius:50%;background:rgba(16,185,129,0.12);color:#10b981;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;">
                  <svg width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
                </div>
                <p style="color:var(--text-primary);font-weight:600;margin:0 0 4px;">当前已是最新版本</p>
                <p style="color:var(--text-tertiary);font-size:13px;margin:0;">v{{ updateCheckResult.currentVersion }}</p>
              </div>

              <!-- 发现新版本 -->
              <div v-else-if="updateCheckResult.status === 'available'">
                <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px;">
                  <div style="width:44px;height:44px;border-radius:10px;background:rgba(245,158,11,0.12);color:var(--accent-color);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-download"/></svg>
                  </div>
                  <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px;">发现新版本</div>
                    <div style="font-size:13px;color:var(--text-tertiary);">
                      新版本 <span style="color:var(--accent-color);font-weight:600;">v{{ updateCheckResult.version }}</span>
                      · 当前 v{{ updateCheckResult.currentVersion }}
                    </div>
                  </div>
                </div>
                <div v-if="updateCheckResult.releaseNotes" style="background:var(--bg-hover);border-radius:var(--radius-md);padding:10px 12px;font-size:12.5px;color:var(--text-secondary);line-height:1.5;max-height:120px;overflow-y:auto;">
                  {{ updateCheckResult.releaseNotes }}
                </div>
                <!-- 下载前询问数据/数据库保存目录，用户可浏览改为自定义文件夹 -->
                <div style="margin-top:12px;">
                  <DataDirPicker />
                </div>
              </div>

              <!-- 错误 -->
              <div v-else-if="updateCheckResult.status === 'error'">
                <div style="display:flex;align-items:flex-start;gap:12px;">
                  <div style="width:44px;height:44px;border-radius:10px;background:rgba(239,68,68,0.12);color:#ef4444;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert-circle"/></svg>
                  </div>
                  <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px;">检查失败</div>
                    <div style="font-size:13px;color:var(--text-tertiary);line-height:1.5;">{{ updateCheckResult.error }}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button v-if="updateCheckResult.status === 'available'" class="btn btn-primary" :disabled="updateStatus === 'installing'" @click="goDownloadUpdate">{{ updateStatus === 'installing' ? '正在安装…' : updateStatus === 'downloaded' ? '立即重启' : updateStatus === 'downloading' ? '查看下载进度' : '立即下载' }}</button>
              <button v-else class="btn btn-primary" @click="showUpdateModal = false">确定</button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 系统日志弹窗 -->
      <Transition name="modal-fade">
        <div v-if="showSystemLog" class="modal-overlay" @click.self="showSystemLog = false">
          <div class="modal-dialog" style="max-width:900px; height:600px;">
            <div class="modal-header">
              <h3>系统日志</h3>
              <button class="modal-close" @click="showSystemLog = false">×</button>
            </div>
            <div class="modal-body" style="padding:0; height:calc(100% - 48px); overflow:hidden;">
              <SystemLogView v-if="showSystemLog" />
            </div>
          </div>
        </div>
      </Transition>

      <!-- 团队服务器不可达回退弹窗（启动检查） -->
      <Transition name="modal-fade">
        <div v-if="showFallbackDialog" class="modal-overlay">
          <div class="modal-dialog" style="max-width:440px;">
            <div class="modal-header">
              <h3>无法连接团队服务器</h3>
            </div>
            <div class="modal-body">
              <div class="db-result-content">
                <div class="db-result-icon" style="background:rgba(239,68,68,0.14);color:var(--accent-red);">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                </div>
                <div class="db-result-message">
                  <p style="font-weight:600;">{{ fallbackUrl }}</p>
                  <p style="color:var(--text-tertiary);font-size:12.5px;">{{ fallbackError }}</p>
                </div>
              </div>
              <p style="color:var(--text-secondary);line-height:1.6;font-size:13px;margin-top:12px;">
                可以重试连接、使用本机 SQLite 备份数据继续工作（仅本次会话生效），<br>
                也可以把本机直接设为团队服务器，无需额外安装。
              </p>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" :disabled="fallbackChecking" @click="retryFallbackCheck">{{ fallbackChecking ? '正在重试...' : '重试连接' }}</button>
              <button class="btn btn-secondary" :disabled="fallbackChecking" @click="becomeHostFromFallback">把本机设为团队服务器</button>
              <button class="btn btn-primary" @click="useLocalBackup">使用本地备份</button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 离线修改提醒弹窗（服务器恢复后启动检查发现未合并的本地修改） -->
      <Transition name="modal-fade">
        <div v-if="showOfflineRemindDialog" class="modal-overlay">
          <div class="modal-dialog" style="max-width:460px;">
            <div class="modal-header">
              <h3>检测到未合并的本地修改</h3>
            </div>
            <div class="modal-body">
              <div class="db-result-content">
                <div class="db-result-icon" style="background:rgba(245,158,11,0.14);color:#f59e0b;">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
                </div>
                <div class="db-result-message">
                  <p style="font-weight:600;">上次团队服务器不可达期间，本机数据库有 {{ offlineRemindMark?.writes || 0 }} 次修改</p>
                  <p style="color:var(--text-tertiary);font-size:12.5px;">
                    离线始于 {{ offlineRemindMark?.sinceText || '—' }}，最后修改 {{ offlineRemindMark?.lastWriteAtText || '—' }}
                  </p>
                  <p v-if="offlineRemindTableSummary" style="color:var(--text-secondary);font-size:12.5px;margin-top:4px;">
                    变更明细：{{ offlineRemindTableSummary }}
                  </p>
                </div>
              </div>
              <p style="color:var(--text-secondary);line-height:1.6;font-size:13px;margin-top:12px;">
                可将离线修改按表同步到团队服务器（只推送有差异的数据），或切换到本地模式核对并导出留档。<br>
                本地的删除操作<b>不会</b>被同步；如需删除请在团队库重新操作。
              </p>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" @click="dismissOfflineRemind">不再提醒</button>
              <button class="btn btn-secondary" @click="viewOfflineData">查看本地数据</button>
              <button class="btn btn-primary" @click="openSyncDialog">同步到服务器</button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 离线修改部分同步弹窗：按业务键比对本地/服务器差异，逐组确认后经网关写入 -->
      <Transition name="modal-fade">
        <div v-if="showSyncDialog" class="modal-overlay">
          <div class="modal-dialog" style="max-width:560px;">
            <div class="modal-header">
              <h3>同步离线修改到团队服务器</h3>
            </div>
            <div class="modal-body">
              <div v-if="syncLoading" style="display:flex;align-items:center;gap:10px;padding:24px 0;justify-content:center;color:var(--text-secondary);font-size:13px;">
                <span class="s-spinner"></span>正在对比本机与团队服务器的数据差异...
              </div>
              <template v-else-if="syncError">
                <div class="db-result-content">
                  <div class="db-result-icon" style="background:rgba(239,68,68,0.14);color:var(--accent-red);">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                  </div>
                  <div class="db-result-message"><p style="font-weight:600;">{{ syncError }}</p></div>
                </div>
                <div class="modal-footer" style="border:none;padding:12px 0 0;justify-content:center;">
                  <button class="btn btn-secondary" @click="closeSyncDialog">关闭</button>
                  <button class="btn btn-primary" @click="openSyncDialog">重试</button>
                </div>
              </template>
              <template v-else-if="!syncDone">
                <p style="color:var(--text-secondary);line-height:1.6;font-size:12.5px;margin-bottom:10px;">
                  仅列出离线期间有修改的数据组；勾选后推送到团队服务器。服务器上较新的数据会保留服务器版本。
                </p>
                <div v-if="!syncItems.length" style="color:var(--text-secondary);font-size:13px;padding:16px 0;text-align:center;">
                  没有检测到可同步的数据表
                </div>
                <label v-for="item in syncItems" :key="item.group" class="sync-item" :class="{ 'sync-item--disabled': !item.total }">
                  <input type="checkbox" v-model="item.checked" :disabled="!item.total || syncRunning" />
                  <div class="sync-item-main">
                    <div class="sync-item-title">
                      {{ item.label }}
                      <span v-if="item.needsAdmin && currentUser && !currentUser.isAdmin" class="sync-admin-warn">需管理员身份</span>
                    </div>
                    <div class="sync-item-summary">{{ item.summary }}</div>
                    <div v-if="item.detail" class="sync-item-detail" :title="item.detail">{{ item.detail }}</div>
                  </div>
                </label>
              </template>
              <template v-else>
                <div v-for="(r, idx) in syncResults" :key="idx" class="sync-result" :class="r.ok ? 'sync-result--ok' : 'sync-result--fail'">
                  <span class="sync-result-dot"></span>
                  <div>
                    <div style="font-weight:600;">{{ r.label }}：{{ r.ok ? '已同步' : '失败' }}</div>
                    <div class="sync-result-detail">{{ r.ok ? r.detail : r.error }}</div>
                  </div>
                </div>
                <div v-if="!syncResults.length" style="color:var(--text-secondary);font-size:13px;padding:16px 0;text-align:center;">
                  没有需要同步的数据
                </div>
                <p style="color:var(--text-secondary);line-height:1.6;font-size:12.5px;margin-top:10px;">
                  已同步的数据将从离线提醒中移除；未勾选、失败或服务器较新的数据会继续保留提醒。
                </p>
              </template>
            </div>
            <div class="modal-footer" v-if="!syncLoading && !syncError">
              <template v-if="!syncDone">
                <button class="btn btn-secondary" :disabled="syncRunning" @click="closeSyncDialog">暂不同步</button>
                <button class="btn btn-primary" :disabled="syncRunning || !syncHasSelection" @click="executeSync">
                  {{ syncRunning ? '正在同步...' : '同步所选数据' }}
                </button>
              </template>
              <template v-else>
                <button class="btn btn-secondary" @click="closeSyncDialog">留在本页</button>
                <button class="btn btn-primary" @click="finishSyncReload">完成并刷新</button>
              </template>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 内容区域：包含离线横幅与主内容，纵向排列防止重叠 -->
      <div class="content-area">
        <!-- 离线会话横幅：回退本地期间持续提示，防止用户误以为在团队库工作。
             服务器自动探测恢复后切换为绿色"可重连"状态（不静默切库，防脑裂） -->
        <div v-if="offlineSession" class="offline-banner" :class="{ 'offline-banner--recovered': serverRecovered }">
          <svg v-if="!serverRecovered" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
          <span v-if="serverRecovered" class="offline-banner-text">
            服务器已恢复：团队服务器重新上线
            <template v-if="offlineSessionWrites > 0">，重连后可按表同步离线期间的修改</template>
            <template v-if="offlineReconnectError">｜重连失败：{{ offlineReconnectError }}</template>
          </span>
          <span v-else class="offline-banner-text" :title="offlineTableSummary ? `本次离线变更明细：${offlineTableSummary}` : ''">
            离线模式：当前使用本机数据库，修改<b>不会同步</b>到团队服务器
            <template v-if="offlineSessionWrites > 0">（本次已离线修改 {{ offlineSessionWrites }} 次）</template>
            <template v-if="offlineTableSummary">｜变更明细：{{ offlineTableSummary }}</template>
            <template v-if="offlineReconnectError">｜重连失败：{{ offlineReconnectError }}</template>
          </span>
          <button class="offline-banner-btn" :disabled="offlineReconnecting" @click="reconnectRemote">
            {{ offlineReconnecting ? '连接中...' : (serverRecovered ? '立即重连' : '重新连接服务器') }}
          </button>
        </div>

        <!-- 主内容区 -->
        <main class="main-content">
        <div v-if="!startupReady" class="startup-check">
          <div class="startup-spinner"></div>
          <span>正在检查数据源连接...</span>
        </div>
        <template v-else>
          <DebuggerView v-show="currentView === 'debugger'" id="view-debugger" class="view" :class="{ active: currentView === 'debugger' }" :active="currentView === 'debugger'" @connection-change="onConnectionChange" />
          <ProtocolConfigView v-show="currentView === 'protocols'" id="view-protocols" class="view" :class="{ active: currentView === 'protocols' }" />
          <AuditReviewView v-show="currentView === 'audit'" id="view-audit" class="view" :class="{ active: currentView === 'audit' }" @pending-change="onPendingChange" />
          <SettingsView v-show="currentView === 'settings'" id="view-settings" class="view" :class="{ active: currentView === 'settings' }" />
          <HelpView v-show="currentView === 'help'" id="view-help" class="view" :class="{ active: currentView === 'help' }" />
          <FeedbackView v-show="currentView === 'feedback'" id="view-feedback" class="view" :class="{ active: currentView === 'feedback' }" />
          <CustomBoardView v-show="currentView === 'board'" id="view-board" class="view" :class="{ active: currentView === 'board' }" />
          <ProtocolPreviewView v-show="currentView === 'protocol-preview'" id="view-protocol-preview" class="view" :class="{ active: currentView === 'protocol-preview' }" />
          <AiChatView v-show="currentView === 'ai-chat'" id="view-ai-chat" class="view" :class="{ active: currentView === 'ai-chat' }" :active="currentView === 'ai-chat'" />
        </template>
        </main>
      </div>
    </div>

    <!-- 自动更新通知（右下角 Toast） -->
    <Transition name="slide-up">
      <div v-if="updateVisible" class="update-toast">
        <div class="update-card" :class="{ 'has-datadir': showDataDirPrompt }">
          <div class="update-main">
            <!-- 圆形图标 -->
            <div class="update-circle" :class="updateStatus">
              <svg v-if="updateStatus === 'available'" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-download"/></svg>
              <svg v-else-if="updateStatus === 'downloading'" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spinning"><use href="#i-refresh-cw"/></svg>
              <svg v-else-if="updateStatus === 'downloaded'" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
              <svg v-else width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert-circle"/></svg>
            </div>

            <!-- 文字区 -->
            <div class="update-text">
              <div class="update-headline">
                <span v-if="updateStatus === 'available'">发现新版本 v{{ updateInfo.version }}</span>
                <span v-else-if="updateStatus === 'downloading'">正在下载更新… {{ downloadPercent }}%</span>
                <span v-else-if="updateStatus === 'downloaded'">更新就绪</span>
                <span v-else-if="updateStatus === 'installing'">正在安装更新…</span>
                <span v-else>更新失败</span>
              </div>
              <div class="update-sub">
                <span v-if="updateStatus === 'available'">当前版本 v{{ updateInfo.currentVersion }}，点击下载更新</span>
                <span v-else-if="updateStatus === 'downloading'" class="update-progress-track"><i class="update-progress-fill" :style="{ width: downloadPercent + '%' }"></i></span>
                <span v-else-if="updateStatus === 'downloaded'">点击重启以更新</span>
                <span v-else>{{ updateError }}</span>
              </div>
            </div>

            <!-- 操作按钮 -->
            <button v-if="updateStatus === 'available'" class="update-btn" @click="startDownloadUpdate">下载</button>
            <button v-else-if="updateStatus === 'downloaded'" class="update-btn" @click="installUpdate">立即重启</button>
            <button v-else-if="updateStatus === 'error'" class="update-btn" @click="retryUpdate">重试</button>

            <!-- 关闭按钮 -->
            <button class="update-close" @click="updateVisible = false">×</button>
          </div>

          <!-- 下载时询问：数据/数据库保存目录，用户可浏览改为自定义文件夹 -->
          <div v-if="showDataDirPrompt" class="update-datadir">
            <DataDirPicker />
          </div>
        </div>
      </div>
    </Transition>

    <!-- 系统通知（左下角 Toast 列表） -->
    <div class="notification-stack">
      <TransitionGroup name="notif-list">
        <div
          v-for="notif in unreadNotifications"
          :key="notif.id"
          class="notif-card"
          :class="notif.type"
          @click="handleNotifClick(notif)"
        >
          <div class="notif-icon">
            <svg v-if="notif.type === 'success'" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
            <svg v-else-if="notif.type === 'warning'" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert-triangle"/></svg>
            <svg v-else-if="notif.type === 'error'" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-x-circle"/></svg>
            <svg v-else width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-bell"/></svg>
          </div>
          <div class="notif-content">
            <div class="notif-title">{{ notif.title }}</div>
            <div class="notif-body">{{ notif.body }}</div>
          </div>
          <button class="notif-close" @click.stop="dismissNotif(notif.id)" title="关闭">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#i-close"/></svg>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch, toRaw } from 'vue';
import { useTheme } from './composables/useTheme';
import { useLogSettings } from './composables/useLogSettings';
import { useReviewQueue } from './composables/useReviewQueue';
import { useCurrentUser } from './composables/useCurrentUser';
import { useNotifications } from './composables/useNotifications';
import { useEmailSuffix } from './composables/useEmailSuffix';
import DebuggerView from './views/DebuggerView.vue';
import ProtocolConfigView from './views/ProtocolConfigView.vue';
import AuditReviewView from './views/AuditReviewView.vue';
import SystemLogView from './views/SystemLogView.vue';
import SettingsView from './views/SettingsView.vue';
import HelpView from './views/HelpView.vue';
import FeedbackView from './views/FeedbackView.vue';
import CustomBoardView from './views/CustomBoardView.vue';
import ProtocolPreviewView from './views/ProtocolPreviewView.vue';
import AiChatView from './views/AiChatView.vue';
import McpGuideDialog from './components/McpGuideDialog.vue';
import FireworksGreeting from './components/FireworksGreeting.vue';
import DataDirPicker from './components/DataDirPicker.vue';
import iconUrl from './assets/icon.svg';

const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
const appVersion = ref('0.0.1');

// 当前用户
const { currentUser, loadKnownUsers, setCurrentUser, restoreUser } = useCurrentUser();

// 登录弹窗（v2：邮箱 + 密码认证）
const showLogin = ref(false);
const authBusy = ref(false);
const authSuccess = ref(false);
const loginError = ref('');
const loginNotice = ref('');
/* 登录视图：login 登录 / register 注册 / forgot 找回密码 */
const loginView = ref('login');
const registerStep = ref(1); // 1 邮箱 → 2 验证码 + 设置密码
const forgotStep = ref(1);   // 1 邮箱 → 2 验证码 + 新密码
/* 服务器状态：false = 未配置团队服务器（显示连接引导，邮箱验证码由服务器发送） */
const serverReady = ref(true);
const serverForm = reactive({ url: '', token: '' });
const sessionState = ref('none'); // none | unreachable
const sessionError = ref('');

/* 首次使用引导：加入团队（扫描）/ 一键成为主机 */
const showJoinPanel = ref(false);
const hostBusy = ref(false);
const loginScanList = ref([]);
const loginScanning = ref(false);
let offLoginScan = null;
/* 首个管理员创建（本机作为主机时免邮箱，无需配置 SMTP） */
const needFirstAdmin = ref(false);
const firstAdminForm = reactive({ email: '', password: '', displayName: '' });
const firstAdminBusy = ref(false);
const firstAdminError = ref('');
const canFirstAdmin = computed(() => !!firstAdminForm.email.trim() && firstAdminForm.password.length >= 8);
/* 启动引导：无有效会话时先显示「选择使用方式」，已配置团队时顶部给「继续」快捷入口 */
const chooseMode = ref(true);
const showChooser = computed(() => !serverReady.value || chooseMode.value);
/* 「选择使用方式」面板是否真正展示（模板分支优先级：不可达 > 本地身份 > 选择页），
   用于把弹窗放宽以容纳一排模式卡片 */
const chooserVisible = computed(() =>
  sessionState.value !== 'unreachable' && loginView.value !== 'local' && showChooser.value
);
const loginForm = reactive({ email: '', password: '' });
const showLoginPassword = ref(false);
const rememberPassword = ref(false);
const registerForm = reactive({ email: '', code: '', password: '', confirmPassword: '', displayName: '' });
const showRegPassword = ref(false);
const forgotForm = reactive({ email: '', code: '', password: '', confirmPassword: '' });
const showForgotPassword = ref(false);

/* 邮箱后缀补全（登录/注册/找回三处输入框共用逻辑） */
const loginEmailEl = ref(null);
const registerEmailEl = ref(null);
const forgotEmailEl = ref(null);
const loginSuggest = useEmailSuffix(() => loginForm.email, (v) => { loginForm.email = v; }, () => loginEmailEl.value);
const registerSuggest = useEmailSuffix(() => registerForm.email, (v) => { registerForm.email = v; }, () => registerEmailEl.value);
const forgotSuggest = useEmailSuffix(() => forgotForm.email, (v) => { forgotForm.email = v; }, () => forgotEmailEl.value);
/* 回车刚用于选中后缀时吞掉本次提交，避免误发验证码/误登录 */
function onLoginEnter() {
  if (loginSuggest.shouldSkipEnter()) return;
  doLogin();
}
function onRegisterEnter() {
  if (registerSuggest.shouldSkipEnter()) return;
  doRegisterRequest(false);
}
function onForgotEnter() {
  if (forgotSuggest.shouldSkipEnter()) return;
  doForgotRequest(false);
}

/* 本地模式（无需服务器）：本机 SQLite 中的身份列表 + 添加表单 */
const localUsers = ref([]);
const localListBusy = ref(false);
const localListError = ref('');
const localAddMode = ref(false);
const localAddForm = reactive({ username: '', project: '', module: '' });

/* 验证码重发倒计时（注册/找回共用，60 秒） */
const resendLeft = ref(0);
let resendTimer = null;
function startResendCountdown() {
  resendLeft.value = 60;
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    resendLeft.value -= 1;
    if (resendLeft.value <= 0) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
  }, 1000);
}

function resetLoginForms() {
  loginForm.email = '';
  loginForm.password = '';
  registerForm.email = '';
  registerForm.code = '';
  registerForm.password = '';
  registerForm.confirmPassword = '';
  registerForm.displayName = '';
  forgotForm.email = '';
  forgotForm.code = '';
  forgotForm.password = '';
  forgotForm.confirmPassword = '';
  loginView.value = 'login';
  registerStep.value = 1;
  forgotStep.value = 1;
  localAddMode.value = false;
  localAddForm.username = '';
  localAddForm.project = '';
  localAddForm.module = '';
  localUsers.value = [];
  localListError.value = '';
  loginError.value = '';
  loginNotice.value = '';
  rememberPassword.value = false;
  if (resendTimer) {
    clearInterval(resendTimer);
    resendTimer = null;
  }
  resendLeft.value = 0;
}

const canLogin = computed(() => loginForm.email.trim() !== '' && loginForm.password !== '');
const canLocalAdd = computed(() => localAddForm.username.trim() !== '');
const canRegisterVerify = computed(() =>
  registerForm.code.trim().length === 6 &&
  registerForm.password.length >= 8 &&
  registerForm.password === registerForm.confirmPassword
);
const canForgotReset = computed(() =>
  forgotForm.code.trim().length === 6 &&
  forgotForm.password.length >= 8 &&
  forgotForm.password === forgotForm.confirmPassword
);
const loginSubtitle = computed(() => {
  if (loginView.value === 'local') {
    return localAddMode.value ? '添加本地身份' : '选择本地身份进入（数据保存在本机）';
  }
  if (!serverReady.value) return '连接团队服务器';
  if (loginView.value === 'register') {
    return registerStep.value === 2 ? `验证码已发送至 ${registerForm.email}` : '注册新账号';
  }
  if (loginView.value === 'forgot') {
    return forgotStep.value === 2 ? `验证码已发送至 ${forgotForm.email}` : '通过注册邮箱找回密码';
  }
  return '使用邮箱和密码登录';
});

/* 修改密码弹窗 */
const showChangePwdDialog = ref(false);
const changePwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });
const showChangeOldPwd = ref(false);
const showChangeNewPwd = ref(false);
const showChangeConfirmPwd = ref(false);
const changePwdError = ref('');
const changePwdBusy = ref(false);

const userDisplayName = computed(() => currentUser.value?.name || '未登录');
const userModuleText = computed(() => {
  if (!currentUser.value) return '—';
  const parts = [];
  if (currentUser.value.department) parts.push(currentUser.value.department);
  if (currentUser.value.project) parts.push(currentUser.value.project);
  if (currentUser.value.module) parts.push(currentUser.value.module);
  return parts.length > 0 ? parts.join(' · ') : '—';
});
const userInitials = computed(() => {
  const name = currentUser.value?.name || 'U';
  return name.slice(0, 2).toUpperCase();
});

/* 密码强度评估（0-4 分） */
function calcPasswordStrength(pwd) {
  if (!pwd) return { score: 0, percent: 0, label: '', cls: '' };
  let score = 0;
  if (pwd.length >= 6) score++;
  if (pwd.length >= 10) score++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
  if (/\d/.test(pwd) && /[^a-zA-Z\d]/.test(pwd)) score++;
  const levels = [
    { percent: 0, label: '', cls: '' },
    { percent: 25, label: '弱', cls: 'weak' },
    { percent: 50, label: '一般', cls: 'medium' },
    { percent: 75, label: '较强', cls: 'good' },
    { percent: 100, label: '强', cls: 'strong' },
  ];
  return { score, ...levels[score] };
}

const changePwdStrengthPercent = computed(() => calcPasswordStrength(changePwdForm.newPassword).percent);
const changePwdStrengthLabel = computed(() => calcPasswordStrength(changePwdForm.newPassword).label);
const changePwdStrengthClass = computed(() => calcPasswordStrength(changePwdForm.newPassword).cls);

const canChangePassword = computed(() =>
  changePwdForm.oldPassword.length > 0 &&
  changePwdForm.newPassword.length >= 8 &&
  changePwdForm.newPassword === changePwdForm.confirmPassword
);

/* 修改密码入口（用户菜单 → 系统 → 修改密码） */
function openChangePassword() {
  changePwdForm.oldPassword = '';
  changePwdForm.newPassword = '';
  changePwdForm.confirmPassword = '';
  changePwdError.value = '';
  userMenuOpen.value = false;
  showChangePwdDialog.value = true;
}

/**
 * 启动登录流程（v2：邮箱 + 密码）
 * 1) 本地数据源（未配置/已回退）→ 恢复上次本地身份直接进入；否则显示连接引导 + 本地模式入口
 * 2) 会话有效 → 直接进入；令牌失效且记住过密码 → 主进程静默重登
 * 3) 服务器不可达 → 登录页顶部提示（保留会话，恢复后自动续上）
 * 浏览器 dev 模式：无认证能力，仅恢复 localStorage 身份用于界面预览
 */
async function initLogin() {
  if (!hasElectron || !window.electronAPI.auth) {
    restoreUser();
    if (!currentUser.value) {
      loginError.value = '邮箱登录需要在桌面应用中使用';
      showLogin.value = true;
    }
    return;
  }
  chooseMode.value = true; /* 启动先出「选择使用方式」，有有效会话时下面会跳过 */
  try {
    const cfg = await window.electronAPI.dbConfig.get();
    if (!(cfg.mode === 'remote' && cfg.effective === 'remote' && cfg.url)) {
      serverReady.value = false;
      serverForm.url = cfg.url || serverForm.url;
      serverForm.token = cfg.token || serverForm.token;
      sessionState.value = 'none';
      /* 本地数据源无需服务器：恢复上次本地身份（readSession 本地分支不发网络请求） */
      try {
        const restored = await window.electronAPI.auth.getSession();
        if (restored && restored.user) {
          setCurrentUser(restored.user);
          showLogin.value = false;
          return;
        }
      } catch { /* 恢复失败停在登录页 */ }
      showLogin.value = true;
      loadKnownUsers();
      return;
    }
    serverReady.value = true;
    /* 记下已配置的服务器，供选择页「继续使用团队服务器」快捷卡片展示与重连 */
    serverForm.url = cfg.url || serverForm.url;
    serverForm.token = cfg.token || serverForm.token;
  } catch {
    serverReady.value = true; /* 配置读取失败按团队模式尝试 */
  }
  try {
    const result = await window.electronAPI.auth.getSession();
    if (result && result.status === 'unreachable') {
      sessionState.value = 'unreachable';
      sessionError.value = result.error || '无法连接团队服务器';
    } else {
      sessionState.value = 'none';
    }
    if (result && result.user) {
      setCurrentUser(result.user);
      showLogin.value = false;
      return;
    }
    if (result && result.status === 'expired') {
      loginError.value = '登录已过期，请重新登录';
    }
  } catch {
    /* 会话恢复失败回到登录 */
  }
  showLogin.value = true;
  loadKnownUsers();
}

/* 登录页"重试"：重新走会话恢复；恢复成功时补齐启动检查
 * 因服务器不可达而跳过的收尾（startupReady 置位 + 清除回退弹窗标记，
 * 否则登录后主界面停留在"正在检查数据源连接"且弹出过期的"无法连接"提示） */
async function retrySession() {
  if (authBusy.value) return;
  authBusy.value = true;
  try {
    await initLogin();
    if (!showLogin.value) {
      showFallbackDialog.value = false;
      startupReady.value = true;
    } else if (sessionState.value === 'unreachable') {
      startUnreachableAutoRetry(); /* 手动重试仍失败 → 重新拉起一轮自动重连（幂等） */
    }
  } finally {
    authBusy.value = false;
  }
}

/* 登录页「服务器不可达」自动重连：
 * 启动竞态下（内嵌服务器 autoStart 就绪约需 0.9s）渲染层首个会话恢复会先于端口
 * 监听到达而落到 unreachable，但服务器随后就绪。因此：
 *   a) 监听 team-server:state，内嵌服务器 running 即刻重连（主路径）；
 *   b) 退避重试若干次（2s/5s/10s/30s），兜住远程服务器短暂闪断。
 * 全部失败才停在手动重试界面；用户手动进入本地模式/设为主机会立即取消。 */
const UNREACHABLE_RETRY_DELAYS_MS = [2000, 5000, 10000, 30000];
let unreachableRetryTimer = null;
let unreachableRetryIdx = 0;
let unreachableAutoActive = false;
let offUnreachableServerState = null;
const unreachableAutoRetrying = ref(false);

function stopUnreachableAutoRetry() {
  if (unreachableRetryTimer) { clearTimeout(unreachableRetryTimer); unreachableRetryTimer = null; }
  if (offUnreachableServerState) { offUnreachableServerState(); offUnreachableServerState = null; }
  unreachableRetryIdx = 0;
  unreachableAutoActive = false;
  unreachableAutoRetrying.value = false;
}

function scheduleNextUnreachableRetry() {
  if (unreachableRetryIdx >= UNREACHABLE_RETRY_DELAYS_MS.length) {
    stopUnreachableAutoRetry(); /* 退避用尽：停在手动重试界面 */
    return;
  }
  const delay = UNREACHABLE_RETRY_DELAYS_MS[unreachableRetryIdx];
  unreachableRetryIdx += 1;
  unreachableAutoRetrying.value = true;
  unreachableRetryTimer = setTimeout(runUnreachableAutoRetry, delay);
}

async function runUnreachableAutoRetry() {
  unreachableRetryTimer = null;
  if (sessionState.value !== 'unreachable') { stopUnreachableAutoRetry(); return; }
  if (authBusy.value) { scheduleNextUnreachableRetry(); return; } /* 用户在手动操作，顺延 */
  await retrySession();
  if (sessionState.value === 'unreachable') scheduleNextUnreachableRetry();
  else stopUnreachableAutoRetry();
}

function startUnreachableAutoRetry() {
  if (unreachableAutoActive) return; /* 已在自动重试（幂等） */
  unreachableAutoActive = true;
  unreachableAutoRetrying.value = true;
  unreachableRetryIdx = 0;
  const ts = hasElectron && window.electronAPI && window.electronAPI.teamServer;
  if (ts && typeof ts.onState === 'function') {
    offUnreachableServerState = ts.onState((state) => {
      /* 内嵌服务器刚就绪 → 立即重连（启动竞态的主恢复路径） */
      if (state && state.running && sessionState.value === 'unreachable'
        && !authBusy.value && !unreachableRetryTimer) {
        runUnreachableAutoRetry();
      }
    });
  }
  scheduleNextUnreachableRetry();
}

/* 状态离开 unreachable（登录成功/切本地模式/设为主机）即停止自动重连 */
watch(sessionState, (v) => {
  if (v === 'unreachable') startUnreachableAutoRetry();
  else stopUnreachableAutoRetry();
});

/* 进入本地身份前确保数据源切到本机 SQLite：
 * 未配置服务器时已是本地无需切换；团队模式（含不可达）则回退并开启离线追踪 */
async function ensureLocalDataSource() {
  if (!offlineSession.value) {
    await useLocalBackup();
  } else {
    startupReady.value = true;
    showFallbackDialog.value = false;
  }
}

/* 本地模式接口守卫：preload 是旧版（应用未完全重启）时给出可读提示，
 * 而不是抛 TypeError 静默失败 */
function requireLocalEnterApi() {
  const api = hasElectron && window.electronAPI && window.electronAPI.auth;
  if (!api || typeof api.localEnter !== 'function') {
    throw new Error('本地模式接口未加载，请完全退出应用后重新启动（刷新页面不会更新主进程）');
  }
  return api;
}

/* 登录页"进入本地模式"：回退本机 SQLite 后自动恢复/建立本地身份；
 * 本机还没有可用身份时转到身份选择页 */
async function enterLocalMode() {
  if (authBusy.value) return;
  stopUnreachableAutoRetry(); /* 用户已做出选择，取消后台自动重连 */
  authBusy.value = true;
  try {
    await ensureLocalDataSource();
    requireLocalEnterApi();
    const r = await window.electronAPI.auth.localEnter({});
    if (r && r.success && r.user) {
      finishAuth(r.user);
      return;
    }
    switchLoginView('local');
    loginError.value = (r && r.error) || '';
  } catch (e) {
    switchLoginView('local');
    loginError.value = '进入失败：' + ((e && e.message) || String(e));
  } finally {
    authBusy.value = false;
  }
}

/* 本地身份列表（只读本机 SQLite，不经过服务器） */
async function loadLocalUsers() {
  if (!hasElectron || !window.electronAPI.auth) return;
  localListBusy.value = true;
  localListError.value = '';
  try {
    const r = await window.electronAPI.auth.listUsers({ forceLocal: true });
    if (r && r.success) {
      localUsers.value = r.users || [];
    } else {
      localListError.value = (r && r.error) || '本地身份列表加载失败';
      localUsers.value = [];
    }
  } catch (e) {
    localListError.value = e.message || String(e);
    localUsers.value = [];
  } finally {
    localListBusy.value = false;
  }
}

/* 本地模式：选择已有身份进入 */
async function doLocalSelect(u) {
  if (!u || authBusy.value) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    await ensureLocalDataSource();
    requireLocalEnterApi();
    const r = await window.electronAPI.auth.localEnter({ userId: u.id });
    if (r && r.success && r.user) {
      finishAuth(r.user);
    } else {
      loginError.value = (r && r.error) || '进入失败';
    }
  } catch (e) {
    loginError.value = '进入失败：' + ((e && e.message) || String(e));
  } finally {
    authBusy.value = false;
  }
}

/* 本地模式：添加身份并进入（同名已存在则直接复用） */
async function doLocalAddUser() {
  if (!canLocalAdd.value || authBusy.value) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    await ensureLocalDataSource();
    requireLocalEnterApi();
    const r = await window.electronAPI.auth.localEnter({
      username: localAddForm.username.trim(),
      displayName: localAddForm.username.trim(),
      project: localAddForm.project.trim(),
      module: localAddForm.module.trim(),
    });
    if (r && r.success && r.user) {
      finishAuth(r.user);
    } else {
      loginError.value = (r && r.error) || '添加失败';
    }
  } catch (e) {
    loginError.value = '添加失败：' + ((e && e.message) || String(e));
  } finally {
    authBusy.value = false;
  }
}

/* 登录/注册成功：logo 弹跳反馈后关闭弹窗 */
function finishAuth(user) {
  authSuccess.value = true;
  setCurrentUser(user);
  sessionState.value = 'none';
  setTimeout(() => {
    showLogin.value = false;
    authSuccess.value = false;
    resetLoginForms();
  }, 450);
  loadKnownUsers();
}

function switchLoginView(view) {
  loginView.value = view;
  loginError.value = '';
  loginNotice.value = '';
  if (view === 'register') {
    registerStep.value = 1;
    registerForm.email = loginForm.email.trim();
  } else if (view === 'forgot') {
    forgotStep.value = 1;
    forgotForm.email = loginForm.email.trim();
  } else if (view === 'local') {
    /* 本地身份页优先级低于不可达卡片，进入前必须清掉不可达状态 */
    sessionState.value = 'none';
    localAddMode.value = false;
    loadLocalUsers();
    stopLoginScan();
  }
}

/* 邮箱 + 密码登录 */
async function doLogin() {
  if (!canLogin.value || authBusy.value) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    const result = await window.electronAPI.auth.login({
      email: loginForm.email.trim(),
      password: loginForm.password,
      remember: rememberPassword.value,
    });
    if (result.success && result.user) {
      finishAuth(result.user);
    } else {
      loginError.value = result.error || '邮箱或密码错误';
    }
  } catch (e) {
    loginError.value = '登录失败：' + (e.message || e);
  }
  authBusy.value = false;
}

/* 注册·第一步：发送邮箱验证码（isResend=true 表示来自重发按钮） */
async function doRegisterRequest(isResend) {
  if (authBusy.value) return;
  if (!isResend && registerStep.value !== 1) return;
  if (isResend && registerStep.value !== 2) return;
  if (!registerForm.email.trim()) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    const result = await window.electronAPI.auth.registerRequest({ email: registerForm.email.trim() });
    if (result.success) {
      registerStep.value = 2;
      registerForm.code = '';
      startResendCountdown();
    } else {
      loginError.value = result.error || '验证码发送失败';
    }
  } catch (e) {
    loginError.value = '发送失败：' + (e.message || e);
  }
  authBusy.value = false;
}

/* 注册·第二步：验证码 + 设置密码，成功即登录 */
async function doRegisterVerify() {
  if (!canRegisterVerify.value || authBusy.value) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    const result = await window.electronAPI.auth.registerVerify({
      email: registerForm.email.trim(),
      code: registerForm.code.trim(),
      password: registerForm.password,
      displayName: registerForm.displayName.trim(),
    });
    if (result.success && result.user) {
      finishAuth(result.user);
    } else {
      loginError.value = result.error || '注册失败';
    }
  } catch (e) {
    loginError.value = '注册失败：' + (e.message || e);
  }
  authBusy.value = false;
}

/* 找回密码·第一步：发送重置验证码 */
async function doForgotRequest(isResend) {
  if (authBusy.value) return;
  if (!isResend && forgotStep.value !== 1) return;
  if (isResend && forgotStep.value !== 2) return;
  if (!forgotForm.email.trim()) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    const result = await window.electronAPI.auth.forgotRequest({ email: forgotForm.email.trim() });
    if (result.success) {
      forgotStep.value = 2;
      forgotForm.code = '';
      startResendCountdown();
    } else {
      loginError.value = result.error || '验证码发送失败';
    }
  } catch (e) {
    loginError.value = '发送失败：' + (e.message || e);
  }
  authBusy.value = false;
}

/* 找回密码·第二步：验证码 + 新密码 */
async function doForgotReset() {
  if (!canForgotReset.value || authBusy.value) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    const result = await window.electronAPI.auth.resetPassword({
      email: forgotForm.email.trim(),
      code: forgotForm.code.trim(),
      password: forgotForm.password,
    });
    if (result.success) {
      /* 回到登录视图并带出提示 */
      loginNotice.value = result.message || '密码已重置，请使用新密码登录';
      loginForm.email = forgotForm.email.trim();
      loginForm.password = '';
      forgotStep.value = 1;
      forgotForm.code = '';
      forgotForm.password = '';
      forgotForm.confirmPassword = '';
      loginView.value = 'login';
    } else {
      loginError.value = result.error || '重置失败';
    }
  } catch (e) {
    loginError.value = '重置失败：' + (e.message || e);
  }
  authBusy.value = false;
}

/* 登录页连接团队服务器（未配置时） */
async function doConnectServer() {
  if (!serverForm.url.trim() || authBusy.value) return;
  authBusy.value = true;
  loginError.value = '';
  try {
    await window.electronAPI.dbConfig.set({
      mode: 'remote',
      url: serverForm.url.trim(),
      token: serverForm.token.trim(),
    });
    const test = await window.electronAPI.dbConfig.test({
      url: serverForm.url.trim(),
      token: serverForm.token.trim(),
      timeoutMs: 3500,
    });
    if (!test.success) {
      loginError.value = test.error || '连接失败，请检查地址与令牌';
      return;
    }
    serverReady.value = true;
    sessionState.value = 'none';
    await initLogin();
    chooseMode.value = false; /* 已选定团队服务器，进入邮箱登录 */
    if (!showLogin.value) {
      showFallbackDialog.value = false;
      startupReady.value = true;
    }
  } catch (e) {
    loginError.value = '连接失败：' + (e.message || e);
  }
  authBusy.value = false;
}

/* 选择页「继续使用团队服务器」：沿用已保存的地址/令牌，直接进入邮箱登录 */
function continueConfiguredMode() {
  if (!serverForm.url) return;
  serverReady.value = true;
  chooseMode.value = false;
  loginError.value = '';
  showJoinPanel.value = false;
  stopLoginScan();
  loginView.value = 'login';
}

/* ---- 首次使用引导：加入团队（扫描）/ 一键成为主机 / 首个管理员 ---- */
function toggleJoinPanel() {
  showJoinPanel.value = !showJoinPanel.value;
  if (showJoinPanel.value) startLoginScan();
  else stopLoginScan();
}

async function startLoginScan() {
  const disc = hasElectron && window.electronAPI && window.electronAPI.discovery;
  if (!disc) return;
  if (!offLoginScan) {
    offLoginScan = disc.onUpdate((list) => { loginScanList.value = list || []; });
  }
  const res = await disc.start();
  loginScanList.value = (res && res.list) || [];
  loginScanning.value = true;
}

async function stopLoginScan() {
  const disc = hasElectron && window.electronAPI && window.electronAPI.discovery;
  if (disc) await disc.stop();
  loginScanning.value = false;
}

async function toggleLoginScan() {
  if (loginScanning.value) await stopLoginScan();
  else await startLoginScan();
}

function applyLoginServer(d) {
  serverForm.url = d.url || '';
}

/* ===================== 「创建团队」：先弹窗选团队数据目录 =====================
 * 团队服务器的数据根目录（server.config.json + server-data/）由用户浏览选定，
 * 不与本机协议库共用路径。弹窗确认后才真正启动内嵌服务器。 */
const showTeamDirDialog = ref(false);
const teamDirForm = reactive({ path: '', busy: false, hint: '', ok: false, err: false });
const TEAM_DIR_DEFAULT_HINT = '团队数据库、服务端配置与备份会保存到这个文件夹';

function teamServerApi() {
  return (hasElectron && window.electronAPI && window.electronAPI.teamServer) || null;
}

async function openTeamDirDialog() {
  const ts = teamServerApi();
  /* 运行环境不提供该能力时保持原行为直接启动，别让整条路径失效 */
  if (!ts || !ts.dataRoot) { await becomeHostAndConnect(); return; }
  showTeamDirDialog.value = true;
  Object.assign(teamDirForm, { path: '', busy: false, ok: false, err: false, hint: TEAM_DIR_DEFAULT_HINT });
  try {
    const r = await ts.dataRoot();
    if (r && r.success && r.dataRoot) teamDirForm.path = r.dataRoot;
  } catch { /* 读取失败就留空，用户可以手动浏览选择 */ }
}

function closeTeamDirDialog() {
  if (teamDirForm.busy) return;
  showTeamDirDialog.value = false;
}

async function browseTeamDir() {
  const ts = teamServerApi();
  if (!ts || !ts.chooseDataRoot || teamDirForm.busy) return;
  try {
    const r = await ts.chooseDataRoot();
    if (r && r.success && r.path) {
      teamDirForm.path = r.path;
      Object.assign(teamDirForm, { ok: false, err: false, hint: TEAM_DIR_DEFAULT_HINT });
    }
  } catch { /* 用户取消或系统对话框调用失败 */ }
}

/* 确认：先落盘目录（server-embed 负责校验与迁移），成功后启动服务器；
 * 启动失败时弹窗不关闭，把错误留在这里显示——否则 becomeHostAndConnect 的
 * loginError 只在登录页可见，用户会以为点了没反应。 */
async function confirmCreateTeam() {
  const ts = teamServerApi();
  if (!ts || !ts.setDataRoot || teamDirForm.busy) return;
  teamDirForm.busy = true;
  Object.assign(teamDirForm, { ok: false, err: false, hint: '' });
  try {
    let r = await ts.setDataRoot(teamDirForm.path);
    /* 服务端已在运行（例如从创建管理员页返回后再次点「创建团队」）且目录要换：
     * 先停机才能让配置与数据库指向同一处，再试一次。 */
    if ((!r || !r.success) && r && r.code === 'running' && ts.stop) {
      const stopped = await ts.stop();
      if (stopped && stopped.success) r = await ts.setDataRoot(teamDirForm.path);
    }
    if (!r || !r.success) {
      Object.assign(teamDirForm, { err: true, hint: (r && r.error) || '保存数据目录失败' });
      return;
    }
    if (r.changed && Array.isArray(r.notes) && r.notes.length) {
      Object.assign(teamDirForm, { ok: true, hint: r.notes.join('；') });
    }
    await becomeHostAndConnect();
    if (serverReady.value) { showTeamDirDialog.value = false; return; }
    Object.assign(teamDirForm, { err: true, hint: loginError.value || '启动团队服务器失败，请重试' });
  } catch (e) {
    Object.assign(teamDirForm, { err: true, hint: String(e.message || e) });
  } finally {
    teamDirForm.busy = false;
  }
}

/* 一键「创建团队」：把本机启动为内嵌局域网主机，并自动把本机切到该服务器 */
async function becomeHostAndConnect() {
  if (hostBusy.value || authBusy.value) return;
  const ts = hasElectron && window.electronAPI && window.electronAPI.teamServer;
  if (!ts) { loginError.value = '当前环境不支持内嵌服务器'; return; }
  stopUnreachableAutoRetry(); /* 用户已做出选择，取消后台自动重连 */
  hostBusy.value = true;
  loginError.value = '';
  try {
    const res = await ts.start({});
    if (!res || !res.success) {
      loginError.value = (res && res.error) || '启动局域网主机失败';
      return;
    }
    const url = res.url || `http://localhost:${res.port}`;
    serverForm.url = url;
    serverForm.token = res.token || '';
    await window.electronAPI.dbConfig.set({ mode: 'remote', url, token: res.token || '' });
    serverReady.value = true;
    sessionState.value = 'none';
    await initLogin();
    chooseMode.value = false; /* 主机已就绪，进入登录/创建管理员 */
    if (!showLogin.value) { showFallbackDialog.value = false; startupReady.value = true; }
    /* 本机作为主机：若还没有可登录管理员，引导直接创建（免邮箱） */
    if (ts.admin) {
      const list = await ts.admin.listUsers();
      if (list && list.success && (list.loginableAdmins || 0) === 0) {
        needFirstAdmin.value = true;
      }
    }
  } catch (e) {
    loginError.value = '启动失败：' + (e.message || e);
  } finally {
    hostBusy.value = false;
  }
}

/* 「创建管理员账号」页右上角返回 → 回到「选择使用方式」页
 * 成为主机后 serverReady=true，showChooser = !serverReady || chooseMode，
 * 因此必须把 chooseMode 置回 true 才能重新展示选择页 */
function backToChooser() {
  needFirstAdmin.value = false;
  firstAdminError.value = '';
  loginError.value = '';
  loginView.value = 'login';
  showJoinPanel.value = false;
  chooseMode.value = true;
}

async function createFirstAdmin() {
  if (!canFirstAdmin.value || firstAdminBusy.value) return;
  const admin = hasElectron && window.electronAPI.teamServer && window.electronAPI.teamServer.admin;
  if (!admin) { firstAdminError.value = '当前环境不支持'; return; }
  firstAdminBusy.value = true;
  firstAdminError.value = '';
  try {
    const r = await admin.createUser({
      email: firstAdminForm.email.trim(),
      password: firstAdminForm.password,
      displayName: firstAdminForm.displayName.trim(),
      role: '管理员',
    });
    if (r && r.success) {
      needFirstAdmin.value = false;
      loginForm.email = firstAdminForm.email.trim();
      loginForm.password = '';
      loginNotice.value = '管理员账号已创建，请输入密码登录';
      loginView.value = 'login';
    } else {
      firstAdminError.value = (r && r.error) || '创建失败';
    }
  } catch (e) {
    firstAdminError.value = e.message || String(e);
  } finally {
    firstAdminBusy.value = false;
  }
}

/* 修改密码 */
async function doChangePassword() {
  if (!canChangePassword.value || changePwdBusy.value) return;
  if (!hasElectron || !window.electronAPI.auth || !currentUser.value) {
    changePwdError.value = '功能仅在 Electron 环境下可用';
    return;
  }
  changePwdBusy.value = true;
  changePwdError.value = '';
  try {
    const result = await window.electronAPI.auth.changePassword({
      userId: currentUser.value.id,
      oldPassword: changePwdForm.oldPassword,
      newPassword: changePwdForm.newPassword,
    });
    if (result.success) {
      showChangePwdDialog.value = false;
    } else {
      changePwdError.value = result.error || '修改失败';
    }
  } catch (e) {
    changePwdError.value = '修改失败：' + (e.message || e);
  }
  changePwdBusy.value = false;
}


// 启动数据源检查：团队模式默认开启，服务器不可达时询问是否使用本地备份
const startupReady = ref(false);
const showFallbackDialog = ref(false);
const fallbackUrl = ref('');
const fallbackToken = ref('');
const fallbackError = ref('');
const fallbackChecking = ref(false);

// 离线会话状态（回退本地后置位，重启后由 effective=local && mode=remote 恢复）
const offlineSession = ref(false);
const offlineSessionWrites = ref(0);
const offlineSessionTables = ref({});
const offlineReconnecting = ref(false);
const offlineReconnectError = ref('');

/* 离线写入的表级明细 → 中文标签（离线脑裂缓解：用户可据此判断需要合并哪些数据） */
const OFFLINE_TABLE_LABELS = {
  protocols: '协议',
  commands: '命令',
  modules: '模块',
  protocol_versions: '协议版本',
  audit_logs: '审核记录',
  users: '用户',
  roles: '角色',
  projects: '项目',
  notifications: '通知',
};
const offlineTableSummary = computed(() => {
  const entries = Object.entries(offlineSessionTables.value || {}).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return '';
  return entries.map(([t, n]) => `${OFFLINE_TABLE_LABELS[t] || t} ${n} 条`).join(' · ');
});

/* 启动提醒弹窗里的表级明细（结构同 offlineTableSummary，数据来自遗留标记文件） */
const offlineRemindTableSummary = computed(() => {
  const entries = Object.entries(offlineRemindMark.value?.tables || {}).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return '';
  return entries.map(([t, n]) => `${OFFLINE_TABLE_LABELS[t] || t} ${n} 条`).join(' · ');
});

/* 离线会话期间轮询标记文件，让横幅上的"已离线修改 N 次"实时增长（5 秒粒度足够） */
let offlinePollTimer = null;
function startOfflinePolling() {
  if (offlinePollTimer) return;
  offlinePollTimer = setInterval(async () => {
    if (!offlineSession.value) return;
    try {
      const r = await window.electronAPI.offlineMark.get();
      if (r.success && r.mark) {
        offlineSessionWrites.value = r.mark.writes;
        offlineSessionTables.value = r.mark.tables || {};
      }
    } catch {
      /* 轮询失败忽略 */
    }
  }, 5000);
}
function stopOfflinePolling() {
  if (offlinePollTimer) {
    clearInterval(offlinePollTimer);
    offlinePollTimer = null;
  }
}

/* ---- 服务器自动探测：离线会话期间每 30 秒探测 /api/health ----
 * 检测到恢复后只切换横幅为"可重连"状态并停止探测，不静默切库：
 * 用户可能正在编辑，数据源突变会导致后续读写突然指向另一个库（防脑裂原则） */
const serverRecovered = ref(false);
let serverDetectTimer = null;
const SERVER_DETECT_INTERVAL_MS = 30000;
function startServerDetection() {
  if (serverDetectTimer || !offlineSession.value) return;
  serverDetectTimer = setInterval(async () => {
    if (!offlineSession.value || serverRecovered.value) return;
    try {
      const r = await window.electronAPI.dbConfig.test({ timeoutMs: 5000 });
      if (r.success) {
        serverRecovered.value = true;
        stopServerDetection();
      }
    } catch { /* 网络异常时静默，下轮继续探测 */ }
  }, SERVER_DETECT_INTERVAL_MS);
}
function stopServerDetection() {
  if (serverDetectTimer) {
    clearInterval(serverDetectTimer);
    serverDetectTimer = null;
  }
}

// 离线修改提醒（服务器恢复后启动检查发现标记文件）
const showOfflineRemindDialog = ref(false);
const offlineRemindMark = ref(null);

async function runStartupDbCheck() {
  if (!hasElectron) {
    startupReady.value = true;
    return;
  }
  try {
    const cfg = await window.electronAPI.dbConfig.get();
    if (cfg.mode === 'remote' && cfg.url) {
      fallbackUrl.value = cfg.url;
      fallbackToken.value = cfg.token || '';
      const r = await window.electronAPI.dbConfig.test({
        url: cfg.url,
        token: cfg.token,
        timeoutMs: 3500,
      });
      if (!r.success) {
        fallbackError.value = r.error || '连接失败';
        showFallbackDialog.value = true;
        return;
      }
      /* 服务器可达：检查是否存在未合并的离线修改标记（上次回退本地期间遗留） */
      try {
        const markRes = await window.electronAPI.offlineMark.get();
        if (markRes.success && markRes.mark && markRes.mark.writes > 0) {
          offlineRemindMark.value = markRes.mark;
          showOfflineRemindDialog.value = true;
        }
      } catch {
        /* 标记读取失败不阻塞启动 */
      }
    } else if (cfg.mode === 'remote' && cfg.effective === 'local') {
      /* 配置为团队模式但当前生效本地：上次会话回退后渲染层刷新（Ctrl+R），
       * 主进程会话级 dbMode 仍是 local——恢复离线横幅与计数，保持提示连续 */
      offlineSession.value = true;
      try {
        const markRes = await window.electronAPI.offlineMark.get();
        offlineSessionWrites.value = markRes.success && markRes.mark ? markRes.mark.writes : 0;
        offlineSessionTables.value = markRes.success && markRes.mark ? (markRes.mark.tables || {}) : {};
      } catch {
        offlineSessionWrites.value = 0;
        offlineSessionTables.value = {};
      }
      startOfflinePolling();
      startServerDetection();
    }
  } catch {
    /* 检查异常时按当前配置继续 */
  }
  startupReady.value = true;
}

async function retryFallbackCheck() {
  fallbackChecking.value = true;
  try {
    const r = await window.electronAPI.dbConfig.test({
      url: fallbackUrl.value,
      token: fallbackToken.value,
      timeoutMs: 3500,
    });
    if (r.success) {
      showFallbackDialog.value = false;
      startupReady.value = true;
    } else {
      fallbackError.value = r.error || '连接失败';
    }
  } catch (e) {
    fallbackError.value = `无法连接服务器: ${e.message}`;
  } finally {
    fallbackChecking.value = false;
  }
}

async function useLocalBackup() {
  try {
    await window.electronAPI.dbConfig.fallbackLocal();
    offlineSession.value = true;
    /* 连续故障的多轮回退会累积计数，读取真实值而非清零 */
    try {
      const markRes = await window.electronAPI.offlineMark.get();
      offlineSessionWrites.value = markRes.success && markRes.mark ? markRes.mark.writes : 0;
      offlineSessionTables.value = markRes.success && markRes.mark ? (markRes.mark.tables || {}) : {};
    } catch {
      offlineSessionWrites.value = 0;
      offlineSessionTables.value = {};
    }
    startOfflinePolling();
    startServerDetection();
  } catch {
    /* 回退失败也继续进入界面 */
  }
  showFallbackDialog.value = false;
  startupReady.value = true;
}

/** 启动回退弹窗：改把本机作为团队服务器（启动内嵌服务器并切到它，整页刷新） */
async function becomeHostFromFallback() {
  const ts = hasElectron && window.electronAPI && window.electronAPI.teamServer;
  if (!ts) { fallbackError.value = '当前环境不支持内嵌服务器'; return; }
  fallbackChecking.value = true;
  try {
    const res = await ts.start({});
    if (!res || !res.success) {
      fallbackError.value = (res && res.error) || '启动局域网主机失败';
      return;
    }
    const url = res.url || `http://localhost:${res.port}`;
    await window.electronAPI.dbConfig.set({ mode: 'remote', url, token: res.token || '' });
    window.location.reload();
  } catch (e) {
    fallbackError.value = '启动失败：' + (e.message || e);
  } finally {
    fallbackChecking.value = false;
  }
}

/** 启动提醒弹窗：用户确认本地修改已合并/留档，清除标记不再提醒 */
async function dismissOfflineRemind() {
  showOfflineRemindDialog.value = false;
  try {
    await window.electronAPI.offlineMark.clear();
  } catch {
    /* 清除失败不影响使用，下次启动仍会提醒 */
  }
}

/** 启动提醒弹窗：本会话切换到本地库查看离线期间的修改（标记保留，合并后再清除） */
async function viewOfflineData() {
  showOfflineRemindDialog.value = false;
  try {
    const r = await window.electronAPI.dbConfig.fallbackLocal();
    if (r && r.offline) {
      /* 整页刷新让各视图重新加载本地数据；横幅由启动检查的
       * "mode=remote && effective=local" 分支自动恢复 */
      window.location.reload();
    }
  } catch {
    /* 切换失败保持当前数据源 */
  }
}

/** 离线横幅：重新连接团队服务器（会话级切回，标记保留直至确认合并完成）。
 *  重连成功后整页刷新；若仍有未合并的本地修改，启动检查会再次弹出提醒，
 *  提醒弹窗提供「同步到服务器」入口（写入需重新登录换取服务器侧用户令牌，故不在本流程内直接同步） */
async function reconnectRemote() {
  offlineReconnecting.value = true;
  offlineReconnectError.value = '';
  try {
    const r = await window.electronAPI.dbConfig.test({ timeoutMs: 5000 });
    if (!r.success) {
      offlineReconnectError.value = r.error || '连接失败';
      /* 探测到的"已恢复"被推翻（服务器闪断），恢复后台探测 */
      serverRecovered.value = false;
      startServerDetection();
      return;
    }
    await window.electronAPI.dbConfig.restoreRemote();
    stopOfflinePolling();
    stopServerDetection();
    window.location.reload();
  } catch (e) {
    offlineReconnectError.value = `无法连接服务器: ${e.message}`;
    serverRecovered.value = false;
    startServerDetection();
  } finally {
    offlineReconnecting.value = false;
  }
}

// 视图切换
const currentView = ref('debugger');
function switchView(view) {
  if (view === currentView.value) return;
  currentView.value = view;
}

/* ===================== 离线修改部分同步（重连后按表合并到团队服务器） =====================
 * 设计约束：
 *  - 本地 SQLite 不是服务器镜像（无下行同步机制），必须按业务键比对：
 *    协议→name、角色→name、用户→username、审核→change_id、版本→(protocol_name, version)；
 *    严禁按自增 id 比对/覆盖——两端 id 独立分配，同 id 可能是不同的数据行
 *  - 协议以 updated_at 判先后（保存/发布流程都会刷新它）：本地较新才整体推送
 *    （协议行 + 版本 + 命令/模块替换，与保存流程同构）；服务器较新则保留服务器版本
 *  - 子表（commands/modules）的 protocol_id 跨库不一致，统一用
 *    (SELECT id FROM protocols WHERE name = ?) 子查询在服务器侧解析，与保存流程一致
 *  - 只做新增/更新，永不删除服务器行：本地删除无法与"服务器新增"区分
 *  - users 表不同步 api_token / api_token_expires / last_login（令牌由服务器签发）
 *  - 全部写入经 /api/batch 网关，管理员权限、防自审、防管理死锁等服务端校验照常生效 */
const showSyncDialog = ref(false);
const syncLoading = ref(false);
const syncError = ref('');
const syncItems = ref([]);
const syncRunning = ref(false);
const syncDone = ref(false);
const syncResults = ref([]);
const syncHasSelection = computed(() => syncItems.value.some(i => i.checked && i.total > 0));

/* 标记表 → 同步分组：命令/模块/版本作为协议子数据随协议整体同步 */
const SYNC_GROUP_MARK_TABLES = {
  protocols: ['protocols', 'commands', 'modules', 'protocol_versions'],
  roles: ['roles'],
  users: ['users'],
  audit_logs: ['audit_logs'],
};
/* 执行顺序：角色先于用户（role_id 按角色名子查询解析），协议先于审核（base_version_id 子查询依赖版本行） */
const SYNC_EXEC_ORDER = { roles: 0, users: 1, protocols: 2, audit_logs: 3 };

function syncNorm(v) { return v === undefined || v === null ? '' : String(v); }
/* 旧库可能缺列（迁移前快照），统一转 null 避免 better-sqlite3 对 undefined 抛错 */
function syncVal(row, col) { return row && row[col] !== undefined ? row[col] : null; }
function syncRowChanged(localRow, serverRow, cols) {
  return cols.some(c => syncNorm(localRow[c]) !== syncNorm(serverRow[c]));
}

/** 打开同步弹窗：读取本地库（sync:read-local，与当前 dbMode 无关）+ 服务器各表，按业务键计算差异 */
async function openSyncDialog() {
  showSyncDialog.value = true;
  syncDone.value = false;
  syncResults.value = [];
  syncLoading.value = true;
  syncError.value = '';
  try {
    const markRes = await window.electronAPI.offlineMark.get();
    const localRes = await window.electronAPI.sync.readLocal();
    if (!localRes.success) throw new Error(localRes.error || '读取本地数据失败');
    const server = {};
    for (const t of ['protocols', 'commands', 'modules', 'protocol_versions', 'audit_logs', 'users', 'roles']) {
      const r = await window.electronAPI.db.query(`SELECT * FROM ${t}`);
      if (!r.success) throw new Error(`读取服务器 ${t} 失败: ${r.error || ''}`);
      server[t] = r.rows || [];
    }
    syncItems.value = computeSyncDiff(localRes.data, server, markRes.mark);
  } catch (e) {
    syncError.value = e.message || String(e);
  } finally {
    syncLoading.value = false;
  }
}

function closeSyncDialog() {
  showSyncDialog.value = false;
}

function finishSyncReload() {
  window.location.reload();
}

function computeSyncDiff(local, server, mark) {
  const marked = new Set(Object.keys((mark && mark.tables) || {}));
  const items = [];
  if (SYNC_GROUP_MARK_TABLES.protocols.some(t => marked.has(t))) items.push(computeProtocolSync(local, server));
  if (SYNC_GROUP_MARK_TABLES.roles.some(t => marked.has(t))) items.push(computeRolesSync(local, server));
  if (SYNC_GROUP_MARK_TABLES.users.some(t => marked.has(t))) items.push(computeUsersSync(local, server));
  if (SYNC_GROUP_MARK_TABLES.audit_logs.some(t => marked.has(t))) items.push(computeAuditSync(local, server));
  return items;
}

/* ---- 协议组：协议行按 name 匹配 + updated_at 判先后；子数据整体随协议 ---- */
function computeProtocolSync(local, server) {
  const serverProtosByName = new Map((server.protocols || []).map(p => [p.name, p]));
  const serverVersionsByKey = new Map((server.protocol_versions || []).map(v => [v.protocol_name + '\u0000' + v.version, v]));
  const localVersionsById = new Map((local.protocol_versions || []).map(v => [v.id, v]));
  const localVersionsByProtoName = new Map();
  for (const v of local.protocol_versions || []) {
    if (!localVersionsByProtoName.has(v.protocol_name)) localVersionsByProtoName.set(v.protocol_name, []);
    localVersionsByProtoName.get(v.protocol_name).push(v);
  }
  const localCommandsByProtoId = new Map();
  for (const c of local.commands || []) {
    if (!localCommandsByProtoId.has(c.protocol_id)) localCommandsByProtoId.set(c.protocol_id, []);
    localCommandsByProtoId.get(c.protocol_id).push(c);
  }
  const localModulesByProtoId = new Map();
  for (const m of local.modules || []) {
    if (!localModulesByProtoId.has(m.protocol_id)) localModulesByProtoId.set(m.protocol_id, []);
    localModulesByProtoId.get(m.protocol_id).push(m);
  }
  const PROTO_CONTENT_COLS = ['version', 'frame_mode', 'frame_length', 'byte_order', 'check_method', 'check_start', 'check_end', 'config_json', 'project'];

  const batches = [];
  const kept = [];
  let newCount = 0;
  let updateCount = 0;
  for (const lp of local.protocols || []) {
    const sp = serverProtosByName.get(lp.name);
    const versions = localVersionsByProtoName.get(lp.name) || [];
    const commands = localCommandsByProtoId.get(lp.id) || [];
    const modules = localModulesByProtoId.get(lp.id) || [];
    let push = false;
    if (!sp) {
      push = true;
      newCount += 1;
    } else if (syncNorm(lp.updated_at) > syncNorm(sp.updated_at)) {
      /* 本地较新：离线编辑/发布都会刷新 updated_at（含仅改命令/模块的场景） */
      push = true;
      updateCount += 1;
    } else if (syncNorm(lp.updated_at) === syncNorm(sp.updated_at)) {
      /* 时间戳相同：内容一致则未改动；内容不同无法判定先后，保守保留服务器版本 */
      if (syncRowChanged(lp, sp, PROTO_CONTENT_COLS)) kept.push(lp.name);
      continue;
    } else {
      /* 服务器较新（离线期间他人在团队库更新）：保留服务器版本 */
      kept.push(lp.name);
      continue;
    }
    if (push) {
      batches.push(buildProtocolStatements(lp, sp, versions, commands, modules, serverVersionsByKey, localVersionsById));
    }
  }
  const total = batches.length;
  const parts = [];
  if (newCount) parts.push(`新增 ${newCount}`);
  if (updateCount) parts.push(`本地较新更新 ${updateCount}`);
  if (kept.length) parts.push(`保留服务器版本 ${kept.length}（服务器较新，本地版本不推送）`);
  if (!parts.length) parts.push('未检测到差异');
  return {
    group: 'protocols',
    label: '协议（含命令 / 模块 / 版本）',
    checked: true,
    total,
    unmerged: kept.length,
    batches,
    newCount,
    updateCount,
    kept,
    summary: parts.join(' · '),
    detail: kept.length ? `保留的协议：${kept.join('、')}` : '',
  };
}

function buildProtocolStatements(lp, sp, versions, commands, modules, serverVersionsByKey, localVersionsById) {
  const stmts = [];
  if (sp) {
    stmts.push({
      sql: 'UPDATE protocols SET version = ?, frame_mode = ?, frame_length = ?, byte_order = ?, check_method = ?, check_start = ?, check_end = ?, config_json = ?, project = ?, updated_at = ? WHERE id = ?',
      params: [syncVal(lp, 'version'), syncVal(lp, 'frame_mode'), syncVal(lp, 'frame_length'), syncVal(lp, 'byte_order'), syncVal(lp, 'check_method'), syncVal(lp, 'check_start'), syncVal(lp, 'check_end'), syncVal(lp, 'config_json'), syncVal(lp, 'project'), syncVal(lp, 'updated_at'), sp.id],
    });
  } else {
    stmts.push({
      sql: 'INSERT INTO protocols (name, version, frame_mode, frame_length, byte_order, check_method, check_start, check_end, config_json, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [lp.name, syncVal(lp, 'version'), syncVal(lp, 'frame_mode'), syncVal(lp, 'frame_length'), syncVal(lp, 'byte_order'), syncVal(lp, 'check_method'), syncVal(lp, 'check_start'), syncVal(lp, 'check_end'), syncVal(lp, 'config_json'), syncVal(lp, 'project'), syncVal(lp, 'created_at'), syncVal(lp, 'updated_at')],
    });
  }
  /* 版本按 (协议名, 版本号) 匹配；新增的用名称子查询解析 protocol_id（两端 id 不一致） */
  for (const lv of versions) {
    const sv = serverVersionsByKey.get(lv.protocol_name + '\u0000' + lv.version);
    if (!sv) {
      stmts.push({
        sql: 'INSERT INTO protocol_versions (protocol_id, protocol_name, version, config_json, status, created_by, created_at) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?, ?, ?, ?, ?)',
        params: [lv.protocol_name, lv.protocol_name, lv.version, syncVal(lv, 'config_json'), syncVal(lv, 'status'), syncVal(lv, 'created_by'), syncVal(lv, 'created_at')],
      });
    } else if (syncRowChanged(lv, sv, ['config_json', 'status', 'created_by'])) {
      stmts.push({
        sql: 'UPDATE protocol_versions SET config_json = ?, status = ?, created_by = ? WHERE id = ?',
        params: [syncVal(lv, 'config_json'), syncVal(lv, 'status'), syncVal(lv, 'created_by'), sv.id],
      });
    }
  }
  /* current_version_id 指向本地版本 id，跨库不可直接用；按 (协议名, 版本号) 在服务器侧解析。
   * 必须放在版本 INSERT 之后（同一事务内顺序执行，子查询才能命中刚插入的行） */
  const curV = lp.current_version_id != null ? localVersionsById.get(lp.current_version_id) : null;
  if (curV) {
    stmts.push({
      sql: 'UPDATE protocols SET current_version_id = (SELECT id FROM protocol_versions WHERE protocol_name = ? AND version = ?) WHERE name = ?',
      params: [curV.protocol_name, curV.version, lp.name],
    });
  } else {
    stmts.push({ sql: 'UPDATE protocols SET current_version_id = NULL WHERE name = ?', params: [lp.name] });
  }
  /* 命令/模块整体替换（与保存流程同构）：先删服务器侧该协议的旧命令，再按本地数据重插 */
  stmts.push({ sql: 'DELETE FROM commands WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [lp.name] });
  for (const c of commands) {
    stmts.push({
      sql: 'INSERT INTO commands (protocol_id, code, name, sender, receiver, period_ms, direction, config_json) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?, ?, ?, ?, ?, ?)',
      params: [lp.name, c.code, c.name, syncVal(c, 'sender'), syncVal(c, 'receiver'), syncVal(c, 'period_ms'), syncVal(c, 'direction'), syncVal(c, 'config_json')],
    });
  }
  for (const m of modules) {
    stmts.push({
      sql: 'INSERT INTO modules (protocol_id, name, address) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?)',
      params: [lp.name, m.name, m.address],
    });
  }
  return { name: lp.name, statements: stmts };
}

/* ---- 角色组：按 name 匹配（服务器写角色需管理员，网关校验） ---- */
function computeRolesSync(local, server) {
  const serverRolesByName = new Map((server.roles || []).map(r => [r.name, r]));
  const statements = [];
  let newCount = 0;
  let updateCount = 0;
  for (const lr of local.roles || []) {
    const sr = serverRolesByName.get(lr.name);
    if (!sr) {
      newCount += 1;
      statements.push({
        sql: 'INSERT INTO roles (name, description, permissions, created_at) VALUES (?, ?, ?, ?)',
        params: [lr.name, syncVal(lr, 'description'), syncVal(lr, 'permissions'), syncVal(lr, 'created_at')],
      });
    } else if (syncRowChanged(lr, sr, ['description', 'permissions'])) {
      updateCount += 1;
      statements.push({
        sql: 'UPDATE roles SET description = ?, permissions = ? WHERE id = ?',
        params: [syncVal(lr, 'description'), syncVal(lr, 'permissions'), sr.id],
      });
    }
  }
  const total = newCount + updateCount;
  return {
    group: 'roles', label: '角色', needsAdmin: true, checked: true, total, unmerged: 0,
    statements, newCount, updateCount,
    summary: total ? `新增 ${newCount} · 更新 ${updateCount}` : '未检测到差异',
  };
}

/* ---- 用户组：按 username 匹配；角色经 role_id→角色名 比对，写入用角色名子查询。
 *  不同步 api_token / api_token_expires / last_login（令牌由服务器登录签发，网关也禁止改令牌列） */
function computeUsersSync(local, server) {
  const localRoleNameById = new Map((local.roles || []).map(r => [r.id, r.name]));
  const serverRoleNameById = new Map((server.roles || []).map(r => [r.id, r.name]));
  const serverUsersByName = new Map((server.users || []).map(u => [u.username, u]));
  const statements = [];
  let newCount = 0;
  let updateCount = 0;
  for (const lu of local.users || []) {
    const su = serverUsersByName.get(lu.username);
    const localRoleName = localRoleNameById.get(lu.role_id) || '';
    if (!su) {
      newCount += 1;
      statements.push({
        sql: 'INSERT INTO users (username, display_name, email, password_hash, role_id, department, project, module, status, created_at) VALUES (?, ?, ?, ?, (SELECT id FROM roles WHERE name = ?), ?, ?, ?, ?, ?)',
        params: [lu.username, syncVal(lu, 'display_name'), syncVal(lu, 'email'), syncVal(lu, 'password_hash'), localRoleName, syncVal(lu, 'department'), syncVal(lu, 'project'), syncVal(lu, 'module'), syncVal(lu, 'status'), syncVal(lu, 'created_at')],
      });
    } else {
      const roleChanged = localRoleName !== (serverRoleNameById.get(su.role_id) || '');
      if (!roleChanged && !syncRowChanged(lu, su, ['display_name', 'email', 'password_hash', 'department', 'project', 'module', 'status'])) continue;
      updateCount += 1;
      /* WHERE 用服务器侧 id：网关的"锁最后一个管理员"等防死锁校验靠解析 id = ? 生效 */
      statements.push({
        sql: 'UPDATE users SET display_name = ?, email = ?, password_hash = ?, role_id = (SELECT id FROM roles WHERE name = ?), department = ?, project = ?, module = ?, status = ? WHERE id = ?',
        params: [syncVal(lu, 'display_name'), syncVal(lu, 'email'), syncVal(lu, 'password_hash'), localRoleName, syncVal(lu, 'department'), syncVal(lu, 'project'), syncVal(lu, 'module'), syncVal(lu, 'status'), su.id],
      });
    }
  }
  const total = newCount + updateCount;
  return {
    group: 'users', label: '用户', needsAdmin: true, checked: true, total, unmerged: 0,
    statements, newCount, updateCount,
    summary: total ? `新增 ${newCount} · 更新 ${updateCount}` : '未检测到差异',
  };
}

/* ---- 审核组：按 change_id 匹配。新增仅允许本人提交的记录（网关硬性校验），
 *  状态更新走 UPDATE 由网关做自审/撤回校验（离线期间的他人审批可由管理员推送） ---- */
function computeAuditSync(local, server) {
  const serverAuditByChangeId = new Map((server.audit_logs || []).map(a => [a.change_id, a]));
  const localVersionsById = new Map((local.protocol_versions || []).map(v => [v.id, v]));
  const currentUsername = currentUser.value?.username || '';
  const statements = [];
  let newCount = 0;
  let updateCount = 0;
  let skipped = 0;
  for (const la of local.audit_logs || []) {
    const sa = serverAuditByChangeId.get(la.change_id);
    if (!sa) {
      if (syncNorm(la.applicant) !== currentUsername) {
        /* 网关只允许以本人身份提交：非当前登录用户创建的离线审核记录跳过 */
        skipped += 1;
        continue;
      }
      newCount += 1;
      const baseV = la.base_version_id != null ? localVersionsById.get(la.base_version_id) : null;
      if (baseV) {
        /* base_version_id 指向本地版本行，按 (协议名, 版本号) 在服务器侧解析 */
        statements.push({
          sql: 'INSERT INTO audit_logs (change_id, protocol_name, change_type, applicant, assignee, scope, status, diff_json, opinion, created_at, snapshot_json, version, base_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM protocol_versions WHERE protocol_name = ? AND version = ?))',
          params: [la.change_id, syncVal(la, 'protocol_name'), syncVal(la, 'change_type'), la.applicant, syncVal(la, 'assignee'), syncVal(la, 'scope'), syncVal(la, 'status'), syncVal(la, 'diff_json'), syncVal(la, 'opinion'), syncVal(la, 'created_at'), syncVal(la, 'snapshot_json'), syncVal(la, 'version'), baseV.protocol_name, baseV.version],
        });
      } else {
        statements.push({
          sql: 'INSERT INTO audit_logs (change_id, protocol_name, change_type, applicant, assignee, scope, status, diff_json, opinion, created_at, snapshot_json, version, base_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          params: [la.change_id, syncVal(la, 'protocol_name'), syncVal(la, 'change_type'), la.applicant, syncVal(la, 'assignee'), syncVal(la, 'scope'), syncVal(la, 'status'), syncVal(la, 'diff_json'), syncVal(la, 'opinion'), syncVal(la, 'created_at'), syncVal(la, 'snapshot_json'), syncVal(la, 'version')],
        });
      }
    } else if (syncRowChanged(la, sa, ['status', 'opinion', 'assignee', 'diff_json', 'scope'])) {
      updateCount += 1;
      statements.push({
        sql: 'UPDATE audit_logs SET status = ?, opinion = ?, assignee = ?, diff_json = ?, scope = ? WHERE change_id = ?',
        params: [syncVal(la, 'status'), syncVal(la, 'opinion'), syncVal(la, 'assignee'), syncVal(la, 'diff_json'), syncVal(la, 'scope'), la.change_id],
      });
    }
  }
  const total = newCount + updateCount;
  const parts = [];
  if (total) parts.push(`新增 ${newCount} · 更新 ${updateCount}`);
  if (skipped) parts.push(`跳过 ${skipped} 条（非当前登录用户提交，服务器仅允许本人提交）`);
  if (!parts.length) parts.push('未检测到差异');
  return {
    group: 'audit_logs', label: '审核记录', checked: true, total, unmerged: skipped,
    statements, newCount, updateCount, skipped,
    summary: parts.join(' · '),
  };
}

/** 执行同步：按 依赖顺序（角色→用户→协议→审核）逐组经 /api/batch 写入；
 *  协议组按协议逐个 batch，单个协议失败不影响其他协议。
 *  已完整处理的组从离线标记裁剪；未勾选/失败/仍有未合并（服务器较新、非本人提交）的组保留标记 */
async function executeSync() {
  syncRunning.value = true;
  syncResults.value = [];
  const keptTables = new Set();
  try {
    const ordered = [...syncItems.value].sort((a, b) => (SYNC_EXEC_ORDER[a.group] ?? 9) - (SYNC_EXEC_ORDER[b.group] ?? 9));
    for (const item of ordered) {
      const markTables = SYNC_GROUP_MARK_TABLES[item.group] || [item.group];
      const actionable = item.checked && item.total > 0;
      let ok = true;
      if (actionable) {
        try {
          if (item.group === 'protocols') {
            for (const pb of item.batches) {
              /* toRaw：syncItems 是 ref，读出的语句数组带 reactive Proxy，
               * Electron IPC 的 V8 序列化不支持 Proxy（DataCloneError），必须解包为原始普通对象 */
              const r = await window.electronAPI.db.batch(toRaw(pb.statements));
              if (!r.success) throw new Error(`协议「${pb.name}」: ${r.error || '同步失败'}`);
            }
            syncResults.value.push({ label: item.label, ok: true, detail: `已推送 ${item.batches.length} 个协议（新增 ${item.newCount} · 更新 ${item.updateCount}）` });
          } else {
            const r = await window.electronAPI.db.batch(toRaw(item.statements));
            if (!r.success) throw new Error(r.error || '同步失败');
            syncResults.value.push({ label: item.label, ok: true, detail: `新增 ${item.newCount} · 更新 ${item.updateCount}` });
          }
        } catch (e) {
          ok = false;
          syncResults.value.push({ label: item.label, ok: false, error: e.message || String(e) });
        }
      }
      /* resolved = 无需执行 或 执行成功，且该组没有留在本地的未合并数据 */
      const resolved = ok && item.unmerged === 0 && (item.checked || item.total === 0);
      if (!resolved) markTables.forEach(t => keptTables.add(t));
    }
    try {
      await window.electronAPI.offlineMark.update([...keptTables]);
    } catch { /* 标记裁剪失败不阻塞：下次启动仍会提醒，可再次同步 */ }
  } finally {
    syncRunning.value = false;
    syncDone.value = true;
  }
}

// 待审核数量（共享队列，协议提交审核后实时更新）
const { pendingCount: auditPendingCount, startPolling: startReviewPolling, stopPolling: stopReviewPolling, loadFromDatabase: loadReviewQueue } = useReviewQueue();

// 处理子视图发出的跳转请求（例如 FeedbackView → SettingsView）
function onSpmSwitchView(e) {
  const view = e?.detail;
  if (view) switchView(view);
}
onMounted(() => {
  window.addEventListener('spm-switch-view', onSpmSwitchView);
});
onUnmounted(() => {
  window.removeEventListener('spm-switch-view', onSpmSwitchView);
  if (offLoginScan) { offLoginScan(); offLoginScan = null; }
  stopUnreachableAutoRetry();
});

/* ===================== 系统通知 ===================== */
const {
  unreadVisible: unreadNotifications,
  loadNotifications,
  markAsRead,
  startPolling,
  stopPolling,
} = useNotifications();

function initNotifications() {
  const userName = currentUser.value?.name;
  if (!userName) return;
  loadNotifications(userName);
  startPolling(userName, 5000);
}

function initReviewPolling() {
  loadReviewQueue(true);  /* 登录后立即拉取一次最新审核数据 */
  startReviewPolling(10000);  /* 每 10 秒刷新一次审核队列 */
}

/* 用户登录后初始化通知 + 审核轮询 + 心跳 */
watch(currentUser, (user) => {
  if (user?.name) {
    initNotifications();
    initReviewPolling();
    if (hasElectron && window.electronAPI.heartbeat) {
      /* 心跳必须上报用户名（服务器按 username 核对在线状态），显示名会匹配失败 */
      window.electronAPI.heartbeat.start(user.username || user.name);
    }
  } else {
    stopPolling();
    stopReviewPolling();
    if (hasElectron && window.electronAPI.heartbeat) {
      window.electronAPI.heartbeat.stop();
    }
  }
}, { immediate: true });

function dismissNotif(id) {
  markAsRead(id);
}

function handleNotifClick(notif) {
  markAsRead(notif.id);
  /* 如果是审核相关通知，跳转到审核页面 */
  if (notif.linkType === 'review') {
    currentView.value = 'audit';
  }
}

/* ===================== 标题栏状态徽章（数据源 / MCP 接入） =====================
 * 数据源徽章反映实际生效的数据源（团队服务器不可达回退本地时显示离线态）；
 * MCP 徽章反映 MCP 桥是否在线，点击弹出配置指南。保存数据源配置会整页刷新，
 * 状态在挂载时读取一次即可；桥启动晚于渲染层时按 2s 间隔重试。 */
const dbEffective = ref('local'); // remote | local（主进程 db-config:get 的 effective）
const dbServerUrl = ref('');
const mcpReady = ref(false);
const mcpBridgePort = ref(null);
const showMcpGuide = ref(false);

const serverPillText = computed(() => {
  if (dbEffective.value === 'remote') return '团队服务器';
  return offlineSession.value ? '本地 · 服务器离线' : '本地服务器';
});
const serverPillTitle = computed(() => (
  dbEffective.value === 'remote'
    ? `数据写入团队服务器 ${dbServerUrl.value}（点击进入 系统设置 → 数据库连接）`
    : '数据写入本机 SQLite（点击进入 系统设置 → 数据库连接）'
));

function goToDbSettings() {
  switchView('settings');
}

async function loadTitlebarStatus() {
  if (!hasElectron || !window.electronAPI.dbConfig) return;
  try {
    const cfg = await window.electronAPI.dbConfig.get();
    dbEffective.value = cfg.effective === 'remote' ? 'remote' : 'local';
    dbServerUrl.value = cfg.url || '';
  } catch { /* 读取失败保持默认本地 */ }
}

async function loadMcpStatus(retries = 5) {
  if (!hasElectron || !window.electronAPI.app?.getMcpInfo) return;
  try {
    const info = await window.electronAPI.app.getMcpInfo();
    mcpReady.value = !!info.bridgeReady;
    mcpBridgePort.value = info.bridgePort || null;
    if (!info.bridgeReady && retries > 0) {
      setTimeout(() => { loadMcpStatus(retries - 1); }, 2000);
    }
  } catch { /* 忽略，保持未启用显示 */ }
}

// 导航项（badge 数字动态响应审核状态）
const navItems = computed(() => [
  { view: 'debugger', iconRef: 'i-serial', text: '串口通信', badge: 'LIVE', badgeClass: 'live' },
  { view: 'protocols', iconRef: 'i-protocol', text: '协议配置', badge: null },
  { view: 'board', iconRef: 'i-dashboard', text: '自定义看板', badge: null },
  { view: 'protocol-preview', iconRef: 'i-preview', text: '协议预览', badge: null },
  { view: 'ai-chat', iconRef: 'i-ai', text: 'AI 助手', badge: null },
  { view: 'audit', iconRef: 'i-audit', text: '变更审核', badge: auditPendingCount.value > 0 ? String(auditPendingCount.value) : null, badgeClass: '' },
]);

// 侧边栏收起/展开
const sidebarCollapsed = ref(false);
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem('spm-sidebar-collapsed', sidebarCollapsed.value);
}

// 用户菜单
const userMenuOpen = ref(false);
function toggleUserMenu(e) {
  e.stopPropagation();
  userMenuOpen.value = !userMenuOpen.value;
}

// 主题
const { currentTheme, setTheme, isDark } = useTheme();
const isDarkMode = computed(() => isDark.value);
function toggleTheme() {
  setTheme(isDark.value ? 'light' : 'dark');
}

// 通信日志换行符显示
const { showNewline, toggleShowNewline } = useLogSettings();

// 检查更新
const updateChecking = ref(false);
const showUpdateModal = ref(false);
const showSystemLog = ref(false);
const updateCheckResult = reactive({
  status: 'idle', // idle | checking | latest | available | error
  version: '',
  currentVersion: '',
  releaseNotes: '',
  error: '',
});

async function checkUpdate() {
  if (!hasElectron || !window.electronAPI.update) {
    updateCheckResult.status = 'error';
    updateCheckResult.error = '当前环境不支持自动更新';
    showUpdateModal.value = true;
    return;
  }

  updateChecking.value = true;
  updateCheckResult.status = 'checking';
  showUpdateModal.value = true;

  try {
    const result = await window.electronAPI.update.check();
    if (result.devMode) {
      updateCheckResult.status = 'latest';
      updateCheckResult.currentVersion = appVersion.value;
    } else if (!result.success) {
      updateCheckResult.status = 'error';
      updateCheckResult.error = result.error || '检查失败';
    } else if (result.available) {
      updateCheckResult.status = 'available';
      updateCheckResult.version = result.version;
      updateCheckResult.currentVersion = result.currentVersion;
      updateCheckResult.releaseNotes = result.releaseNotes || '';
      applyUpdateState(result, false);
    } else {
      updateCheckResult.status = 'latest';
      updateCheckResult.currentVersion = result.currentVersion || appVersion.value;
    }
  } catch (e) {
    updateCheckResult.status = 'error';
    updateCheckResult.error = String(e.message || e);
  } finally {
    updateChecking.value = false;
  }
}

function goDownloadUpdate() {
  showUpdateModal.value = false;
  updateVisible.value = true;
  if (updateStatus.value === 'downloaded') installUpdate();
  else if (updateStatus.value !== 'downloading' && updateStatus.value !== 'installing') startDownloadUpdate();
}

// 切换用户（清除主进程会话文件，返回用户选择界面）
const showLogoutDialog = ref(false);

/* ===================== MCP 写操作确认弹窗（主进程请求 → 渲染层展示 → 回传结果） ===================== */
const mcpConfirm = reactive({
  visible: false, id: '', title: 'MCP 操作确认',
  message: '', detail: '', checkboxLabel: '', remember: false,
});

function respondMcpConfirm(allowed) {
  if (!mcpConfirm.visible) return;
  try {
    window.electronAPI?.mcpConfirm?.respond({
      id: mcpConfirm.id,
      allowed,
      remember: allowed && mcpConfirm.remember,
    });
  } catch { /* 主进程超时兜底 */ }
  mcpConfirm.visible = false;
}

if (window.electronAPI?.mcpConfirm) {
  window.electronAPI.mcpConfirm.onRequest((req) => {
    if (!req || !req.id) return;
    mcpConfirm.id = req.id;
    mcpConfirm.title = req.title || 'MCP 操作确认';
    mcpConfirm.message = req.message || '';
    mcpConfirm.detail = req.detail || '';
    mcpConfirm.checkboxLabel = req.checkboxLabel || '记住"允许执行"，此后不再询问';
    mcpConfirm.remember = false;
    mcpConfirm.visible = true;
  });
}

function onMcpConfirmKeydown(e) {
  if (!mcpConfirm.visible) return;
  if (e.key === 'Enter') { e.preventDefault(); respondMcpConfirm(true); }
  else if (e.key === 'Escape') { e.preventDefault(); respondMcpConfirm(false); }
}
window.addEventListener('keydown', onMcpConfirmKeydown);
onUnmounted(() => window.removeEventListener('keydown', onMcpConfirmKeydown));

async function confirmLogout() {
  if (hasElectron && window.electronAPI.auth) {
    try {
      await window.electronAPI.auth.logout();
    } catch {
      /* ignore */
    }
  }
  setCurrentUser(null);
  showLogoutDialog.value = false;
  userMenuOpen.value = false;
  showChangePwdDialog.value = false;
  resetLoginForms();
  sessionState.value = 'none';
  showLogin.value = true;
  /* 重新评估数据源状态（本地/团队模式登录页形态不同） */
  await initLogin();
}

// 窗口控制
function onWindowAction(action) {
  if (!hasElectron) return;
  if (action === 'minimize') window.electronAPI.window.minimize();
  else if (action === 'maximize') window.electronAPI.window.maximize();
  else if (action === 'close') window.electronAPI.window.close();
}

function onTitlebarDblClick(e) {
  if (!hasElectron) return;
  if (e.target.closest('.titlebar-btn') || e.target.closest('.sidebar-toggle')) return;
  window.electronAPI.window.maximize();
}

// 连接状态
const hasOpenConnection = ref(false);
function onConnectionChange(open) {
  hasOpenConnection.value = open;
}

// 审核待办数量同步
function onPendingChange(count) {
  auditPendingCount.value = count;
}

// 全局点击关闭用户菜单
function onGlobalClick(e) {
  const popup = document.querySelector('.user-menu-popup');
  const trigger = document.querySelector('.user-mini');
  if (popup && trigger && !popup.contains(e.target) && !trigger.contains(e.target)) {
    userMenuOpen.value = false;
  }
}

/* 登录弹窗 Logo 贪吃蛇动画：在运行时注入 <style> 到 <head> 末尾
 *
 * 生效稳定性踩过的坑 & 最终做法：
 *   1) SVG 内部 <style> → 被 Vue/SFC 编译阶段剥离 → ❌ 不用
 *   2) App.vue <style> 块 → 打包到 CSS 产物头部，被 styles.css / 同名 @media reduce
 *      重置规则覆盖 → ❌ 已删除
 *   3) stroke-dashoffset 基础声明带 !important → 按 CSS 级联规范"作者 !important 关键帧
 *      优先级 > animation 普通关键帧"，蛇永远锁死不动 → ❌ 改为：基础规则只写
 *      stroke-dasharray + animation（!important 防 CSS Reset），dashoffset 变化
 *      只在 @keyframes 里声明（animation origin 高于普通 author 声明），这样基础
 *      规则里 dashoffset 不带 !important，keyframes 才能正常覆盖 → ✅
 *   4) pathLength 属性在某些 Chromium 构建里和 animated dashoffset 交互错误
 *      → ❌ 已从 <path> 移除，改用真实像素长度 1060（刚好与原归一化值相等，数值不变）
 *   5) 系统 prefers-reduced-motion=true：之前的 @media reduce { animation:none !important }
 *      会覆盖动画声明 → ❌ 用户明确要求看到动画，不默认加 reduce 关闭。
 *      真需要关闭时控制台执行 document.documentElement.dataset.spmAnimate='0' 即可。 */
function injectSnakeAnimStyle() {
  if (document.getElementById('spm-snake-anim')) return;
  const el = document.createElement('style');
  el.id = 'spm-snake-anim';
  el.textContent = `
    /* 基础规则：dasharray 锁定 1060 / 1060（与真实像素长度一致）
       animation 用 !important 防 CSS Reset 覆盖
       ⚠️ dashoffset 此处不写 !important，以便 @keyframes 能正常覆盖它 */
    .login-logo svg path.s-snake {
      stroke-dasharray: 1060 1060 !important;
      animation: s-snake-eat 2.4s cubic-bezier(.42,0,.58,1) infinite !important;
    }
    .login-logo svg circle.s-dot {
      transform-box: fill-box !important;
      transform-origin: center !important;
      animation: s-dot-gulp 2.4s linear infinite !important;
    }
    .login-logo.busy svg path.s-snake { animation-duration: 0.9s !important; animation-timing-function: linear !important; }
    .login-logo.busy svg circle.s-dot   { animation-duration: 0.9s !important; }
    .login-logo.success { animation: login-logo-pop 0.45s cubic-bezier(0.175,0.885,0.32,1.275) 1 !important; }

    /* dashoffset 变化只能放在 @keyframes 里（animation origin > 普通 author origin），
       否则被 !important 基础声明锁死 → 蛇永远不动 */
    @keyframes s-snake-eat {
      0%   { stroke-dashoffset:  1060; }   /* 空场 → 蛇头刚入场 */
      38%  { stroke-dashoffset:     0; }   /* 蛇爬满阶梯，头碰到食物 */
      58%  { stroke-dashoffset:     0; }   /* 停顿 20% 时间，"享受食物" */
      92%  { stroke-dashoffset: -1060; }   /* 尾追上，蛇整体向前离场 */
      100% { stroke-dashoffset: -1060; }   /* 空场，衔接下一轮 */
    }
    @keyframes s-dot-gulp {
      0%,36%  { transform: scale(1);   opacity: 1; }   /* 等待被吃 */
      40%,95% { transform: scale(.1);  opacity: 0; }   /* 被吞掉 */
      100%    { transform: scale(1);   opacity: 1; }   /* 下一轮刷新 */
    }
    @keyframes login-logo-pop {
      0%   { transform: scale(1); }
      60%  { transform: scale(1.25); }
      100% { transform: scale(1); }
    }

    /* 手动关闭开关：控制台执行 document.documentElement.dataset.spmAnimate='0' 可停动画 */
    html[data-spm-animate="0"] .login-logo svg path.s-snake,
    html[data-spm-animate="0"] .login-logo svg circle.s-dot,
    html[data-spm-animate="0"] .login-logo.success { animation: none !important; }
    html[data-spm-animate="0"] .login-logo svg path.s-snake { stroke-dashoffset: 0; }
  `;
  document.head.appendChild(el);
  // 默认明确启用动画（系统 reduce 偏好不再默认关）
  document.documentElement.dataset.spmAnimate = '1';
}

onMounted(() => {
  sidebarCollapsed.value = localStorage.getItem('spm-sidebar-collapsed') === 'true';
  document.addEventListener('click', onGlobalClick);
  injectSnakeAnimStyle();
  initLogin();
  runStartupDbCheck();
  loadTitlebarStatus();
  loadMcpStatus();
  checkForUpdate();
  if (hasElectron && window.electronAPI.app) {
    window.electronAPI.app.getVersion().then(v => { appVersion.value = v; });
    /* 同步更新通知偏好到主进程 */
    const notifyPref = localStorage.getItem('spm-update-notify');
    const enabled = notifyPref === null ? true : notifyPref === '1';
    window.electronAPI.app.setUpdateNotify?.(enabled);
  }
});

/* ===================== 自动更新 ===================== */
const updateVisible = ref(false);
const updateStatus = ref('idle');
const updateInfo = reactive({ version: '', currentVersion: '', releaseNotes: '' });
const updateError = ref('');
const updateErrorStage = ref('check');
const downloadPercent = ref(0);

/* 更新下载时内嵌询问「数据/数据库保存目录」：
   仅在拿到新版本、尚未进入安装阶段时显示（available = 待下载，downloading = 正在下载） */
const showDataDirPrompt = computed(() =>
  updateVisible.value
  && (updateStatus.value === 'available' || updateStatus.value === 'downloading')
);
const updateUnsubscribers = [];

function applyUpdateState(data, show = true) {
  if (!data?.success || !data.available) return;
  Object.assign(updateInfo, { version: data.version, currentVersion: data.currentVersion, releaseNotes: data.releaseNotes || '' });
  const phase = data.phase || 'available';
  // A delayed system notification must not reset a download already in progress.
  if (phase !== 'available' || !['downloading', 'downloaded', 'installing'].includes(updateStatus.value)) updateStatus.value = phase;
  if (show) updateVisible.value = true;
}
function showUpdateError(data, stage) {
  updateErrorStage.value = data?.stage || stage;
  updateError.value = data?.error || '更新失败，请重试';
  updateStatus.value = 'error';
  updateVisible.value = true;
}
async function checkForUpdate() {
  if (!hasElectron || !window.electronAPI.update) return;
  try { applyUpdateState(await window.electronAPI.update.check()); }
  catch { /* Background network failures remain quiet; manual checks report errors. */ }
}
if (hasElectron && window.electronAPI.update) {
  const api = window.electronAPI.update;
  updateUnsubscribers.push(
    api.onAvailable(data => applyUpdateState(data)),
    api.onShowAvailable(data => applyUpdateState(data)),
    api.onProgress(data => {
      if (updateStatus.value === 'downloading') downloadPercent.value = Math.min(100, Math.max(0, Math.round(data.percent || 0)));
    }),
    api.onDownloaded(data => { applyUpdateState(data); downloadPercent.value = 100; }),
    api.onError(data => showUpdateError(data, 'download')),
  );
}
async function startDownloadUpdate() {
  if (!hasElectron || !window.electronAPI.update || ['downloading', 'installing'].includes(updateStatus.value)) return;
  updateStatus.value = 'downloading';
  downloadPercent.value = 0;
  updateVisible.value = true;
  try {
    const result = await window.electronAPI.update.download();
    if (!result.success) showUpdateError(result, 'download');
    else applyUpdateState(result);
  } catch (error) { showUpdateError({ error: String(error.message || error) }, 'download'); }
}
async function installUpdate() {
  if (!hasElectron || !window.electronAPI.update || updateStatus.value !== 'downloaded') return;
  updateStatus.value = 'installing';
  try {
    const result = await window.electronAPI.update.install();
    if (!result.success) showUpdateError(result, 'install');
  } catch (error) { showUpdateError({ error: String(error.message || error) }, 'install'); }
}
async function retryUpdate() {
  if (updateErrorStage.value === 'install') { updateStatus.value = 'downloaded'; return installUpdate(); }
  if (updateErrorStage.value === 'download') return startDownloadUpdate();
  return checkUpdate();
}

onUnmounted(() => {
  for (const unsubscribe of updateUnsubscribers) unsubscribe?.();
  document.removeEventListener('click', onGlobalClick);
  stopOfflinePolling();
});
</script>
<!-- 注：登录弹窗贪吃蛇 LOGO 动画统一由 injectSnakeAnimStyle() 在运行时注入。
     此处不再保留静态 <style> 块，避免以下冲突：
     1) 底部 App.vue <style> 里 @media reduce { animation: none !important } 会覆盖动画声明
     2) 基础 stroke-dashoffset: xxx !important 与 @keyframes 的级联顺序导致蛇身永不移动（详见 injectSnakeAnimStyle 注释）
     3) SVG pathLength 属性与 animated dashoffset 在某些渲染器里有交互 bug -->
