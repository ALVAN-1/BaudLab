<template>
  <section class="view" :class="{ 'cmd-expanded': commandPanelExpanded }">
    <div class="view-header">
      <div>
        <h1 class="view-title">协议配置</h1>
        <p class="view-subtitle">自定义帧格式、命令字与字段解析规则</p>
      </div>
      <div class="view-actions">
        <button class="btn btn-secondary" @click="importProtocol">导入协议</button>
        <button class="btn btn-secondary" @click="exportProtocol">导出协议</button>
        <button class="btn btn-secondary" @click="openHistoryDialog">历史版本</button>
        <button class="btn btn-primary" @click="newProtocol">新建协议</button>
      </div>
    </div>

    <!-- 保存提示 Toast -->
    <Transition name="toast-slide">
      <div v-if="toast.show" class="save-toast" :class="toast.type">
        <span class="toast-icon">{{ toast.type === 'success' ? '✓' : '✕' }}</span>
        <span class="toast-text">{{ toast.message }}</span>
      </div>
    </Transition>

    <!-- 未保存变更确认弹窗 -->
    <Transition name="modal-fade">
      <div v-if="unsavedDialog.show" class="modal-overlay" @click.self="unsavedDialog.show = false">
        <div class="modal-dialog unsaved-dialog">
          <div class="modal-header">
            <h3>未保存的变更</h3>
          </div>
          <div class="modal-body">
            <p>协议「{{ unsavedDialog.fromName }}」的配置已修改但尚未保存。</p>
            <p style="margin-top:8px;color:var(--text-secondary);">切换到「{{ unsavedDialog.toName }}」前是否保存当前变更？</p>
            <label class="modal-checkbox">
              <input type="checkbox" v-model="dontAskAgain">
              <span>不再提醒未保存变更</span>
            </label>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="unsavedCancel">不保存</button>
            <button class="btn btn-primary" @click="unsavedSaveAndSwitch">保存并切换</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 保存冲突弹窗（乐观锁） -->
    <Transition name="modal-fade">
      <div v-if="conflictDialog.show" class="modal-overlay">
        <div class="modal-dialog" style="max-width:440px;">
          <div class="modal-header">
            <h3>保存冲突</h3>
          </div>
          <div class="modal-body">
            <p>协议「{{ activeProtocol }}」已被其他用户修改并保存（可能来自团队服务器上的新版本）。</p>
            <p style="margin-top:8px;color:var(--text-secondary);">为避免覆盖他人的变更，请加载最新版本后再重新应用您的修改；加载后本地未保存的修改将丢失。</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="conflictDialog.show = false">取消</button>
            <button class="btn btn-primary" @click="conflictReloadLatest">加载最新版本</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 历史版本弹窗 -->
    <Transition name="modal-fade">
      <div v-if="historyDialog.show" class="modal-overlay" @click.self="historyDialog.show = false">
        <div class="modal-dialog history-dialog">
          <div class="modal-header">
            <h3>历史版本 · {{ activeProtocol }}</h3>
          </div>
          <div class="modal-body">
            <div v-if="historyDialog.loading" class="history-empty">加载中…</div>
            <div v-else-if="historyDialog.versions.length === 0" class="history-empty">
              暂无历史版本，保存协议后将自动记录版本快照
            </div>
            <div v-else class="history-list">
              <div
                v-for="(v, vi) in historyDialog.versions"
                :key="v.id"
                class="history-item"
                :class="{ current: vi === 0 }"
              >
                <div class="history-item-main">
                  <span class="history-version">{{ v.version }}</span>
                  <span v-if="vi === 0" class="history-badge">当前</span>
                  <span class="history-meta">{{ v.created_by || '未知用户' }} · {{ v.created_at }}</span>
                </div>
                <button class="btn btn-secondary btn-small" @click="loadVersion(v)">载入</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="historyDialog.show = false">关闭</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 导出协议弹窗 -->
    <Transition name="modal-fade">
      <div v-if="exportDialog.show" class="modal-overlay" @click.self="exportDialog.show = false">
        <div class="modal-dialog export-dialog">
          <div class="modal-header">
            <h3>导出协议</h3>
          </div>
          <div class="modal-body">
            <div class="export-section-label">选择导出格式</div>
            <div class="export-format-grid">
              <div
                v-for="f in exportFormats"
                :key="f.id"
                class="export-format-card"
                :class="{ active: exportFormat === f.id }"
                @click="exportFormat = f.id"
              >
                <div class="export-format-ext">{{ f.ext }}</div>
                <div class="export-format-name">{{ f.name }}</div>
                <div class="export-format-desc">{{ f.desc }}</div>
                <div class="export-format-check">✓</div>
              </div>
            </div>
            <div class="export-filename-block">
              <div class="export-section-label">保存文件名</div>
              <div class="export-filename-value">
                <span class="export-filename-base">{{ exportBaseName }}</span>
                <span class="export-filename-ext">.{{ exportFormat }}</span>
              </div>
              <div class="export-filename-hint">文件名随当前协议编辑内容实时更新；点击导出后可选择保存路径</div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="exportDialog.show = false">取消</button>
            <button class="btn btn-primary" :disabled="exporting" @click="confirmExport">
              {{ exporting ? '导出中…' : '导出' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 帧格式预览条 -->
    <div class="protocol-frame-preview-bar">
      <div class="preview-label">帧格式预览</div>
      <div class="preview-bytes">
        <div
          class="preview-group"
          v-for="g in previewGroups"
          :key="g.key"
          :class="{ 'check-range-group': g.inCheckRange }"
        >
          <span class="preview-group-label">{{ g.label }}</span>
          <span
            v-for="(b, bi) in g.bytes"
            :key="bi"
            class="preview-byte"
            :class="[g.cls, { 'check-range-byte': g.inCheckRange }]"
          >{{ b }}</span>
        </div>
      </div>
    </div>

    <div class="panel-grid grid-2 protocol-config-grid" :class="{ 'list-folded': listCollapsed }">
      <!-- 协议列表 -->
      <div class="panel protocol-list">
        <div class="panel-header">
          <svg class="group-chevron list-chevron" :class="{ collapsed: listCollapsed }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" @click="listCollapsed = !listCollapsed"><path d="M6 9l6 6 6-6"/></svg>
          <h3 class="list-title" @click="listCollapsed = !listCollapsed">协议列表</h3>
          <input v-show="!listCollapsed" type="text" class="input search" placeholder="搜索协议...">
          <div v-show="listCollapsed" class="folded-stack">
            <div
              v-for="fp in flatProtocols"
              :key="fp.uid"
              class="folded-avatar"
              :class="{ active: fp.name === activeProtocol }"
              :style="{ '--pc': fp.groupColor }"
              :title="'切换到：' + fp.name"
              @click="selectProtocol(fp)"
            >{{ (fp.name || '?')[0] }}</div>
          </div>
        </div>
        <div v-show="!listCollapsed" class="panel-body">
          <div v-if="projectFilter" class="project-filter-bar" @click="projectFilter = ''">
            <span>筛选: {{ projectFilter }}</span>
            <span class="filter-clear">×</span>
          </div>
          <div
            v-for="group in groupedProtocols"
            :key="group.name"
            class="project-group"
          >
            <div class="project-group-header" :style="{ '--group-color': group.color }" @click="toggleGroup(group.name)">
              <svg class="group-chevron" :class="{ collapsed: collapsedGroups[group.name] }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              <span class="group-color-dot" :style="{ background: group.color }"></span>
              <span class="group-name">{{ group.name }}</span>
              <span class="group-count">{{ group.protos.length }}</span>
            </div>
            <div v-show="!collapsedGroups[group.name]" class="project-group-body">
              <div
                v-for="proto in group.protos"
                :key="proto.uid"
                class="protocol-card"
                :class="{ active: proto.name === activeProtocol, unsaved: proto.name === activeProtocol && hasUnsavedChanges }"
                @click="selectProtocol(proto)"
                @contextmenu.prevent="onProtocolContextMenu($event, proto)"
              >
                <span class="protocol-name">{{ proto.name === activeProtocol ? protoName : proto.name }}</span>
                <div class="protocol-line2">
                  <span class="protocol-tag" :class="{ draft: proto.draft }">{{ proto.draft ? '草稿' : proto.status }}</span>
                  <span v-if="proto.project" class="protocol-tag project-tag" @click.stop="filterByProject(proto.project)" :title="'点击筛选项目: ' + proto.project">{{ proto.project }}</span>
                  <span v-if="proto.name === activeProtocol && hasUnsavedChanges" class="protocol-tag unsaved-tag">未保存</span>
                  <span v-if="proto.reviewStatus" class="protocol-review-tag" :class="proto.reviewStatus">{{ reviewStatusText(proto.reviewStatus) }}</span>
                  <span class="protocol-version">{{ proto.name === activeProtocol ? `v${versionMajor}.${versionMinor}.${versionPatch}` : proto.version }}</span>
                </div>
                <div class="protocol-card-actions">
                  <button
                    v-if="!proto.reviewStatus || proto.reviewStatus === 'rejected'"
                    class="btn btn-secondary btn-small protocol-review-btn"
                    title="提交审核"
                    @click.stop="submitForReview(proto)"
                  >提交审核</button>
                  <button
                    v-else-if="proto.reviewStatus === 'pending'"
                    class="btn btn-secondary btn-small protocol-review-btn btn-pending"
                    disabled
                  >审核中</button>
                  <button
                    v-else-if="proto.reviewStatus === 'approved'"
                    class="btn btn-success btn-small protocol-review-btn"
                    title="审核通过，点击发布生效"
                    @click.stop="publishProtocol(proto)"
                  >发布生效</button>
                  <button
                    v-else-if="proto.reviewStatus === 'published'"
                    class="btn btn-success btn-small protocol-review-btn"
                    disabled
                  >已生效</button>
                  <button
                    class="btn btn-danger btn-small protocol-delete-btn"
                    title="删除协议"
                    @click.stop="deleteProtocol(proto)"
                  >删除</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 协议编辑器 -->
      <div class="panel protocol-editor">
        <div class="panel-header">
          <h3>协议编辑器</h3>
          <button class="btn btn-primary btn-small" @click="saveConfig">{{ saveStatus }}</button>
        </div>
        <div class="panel-body protocol-editor-body">

          <!-- 协议基础信息 -->
          <div class="panel collapsible" :class="{ collapsed: panels.basic }">
            <div class="panel-header" data-collapse @click="panels.basic = !panels.basic">
              <h3>协议基础信息</h3>
              <button
                class="panel-toggle"
                type="button"
                title="收起/展开"
                @click.stop="panels.basic = !panels.basic"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
            </div>
            <div class="panel-body">
              <div class="form-row inline">
                <div class="flex-2">
                  <label>协议名称</label>
                  <input type="text" class="input" v-model="protoName">
                </div>
                <div class="flex-1">
                  <label>协议版本</label>
                  <div class="version-input" title="协议版本号：V主版本.次版本.修订号">
                    <span class="version-prefix">V</span>
                    <input type="number" class="input" v-model.number="versionMajor" min="0" max="255">
                    <span class="version-dot">.</span>
                    <input type="number" class="input" v-model.number="versionMinor" min="0" max="255">
                    <span class="version-dot">.</span>
                    <input type="number" class="input" v-model.number="versionPatch" min="0" max="255">
                  </div>
                </div>
              </div>
              <div class="form-row">
                <label>协议描述</label>
                <textarea class="input" rows="2" placeholder="输入协议用途说明..." v-model="protoDesc">用于多传感器节点数据采集与控制。</textarea>
              </div>
            </div>
          </div>

          <!-- 帧格式配置 -->
          <div class="panel collapsible" :class="{ collapsed: panels.frame }">
            <div class="panel-header" data-collapse @click="panels.frame = !panels.frame">
              <h3>帧格式配置</h3>
              <button
                class="panel-toggle"
                type="button"
                title="收起/展开"
                @click.stop="panels.frame = !panels.frame"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
            </div>
            <div class="panel-body">
              <div class="form-row">
                <label class="section-subtitle">启用字段（拖拽卡片可调整字节顺序）</label>
                <div class="field-toggles">
                  <div
                    v-for="(key, idx) in fieldOrder"
                    :key="key"
                    class="checkbox field-card"
                    :class="{ 'drag-over': dragOverIdx === idx, dragging: dragIdx === idx }"
                    draggable="true"
                    :data-field-toggle="key"
                    @dragstart="onDragStart(idx, $event)"
                    @dragover.prevent="onDragOver(idx)"
                    @dragleave="onDragLeave(idx)"
                    @drop="onDrop(idx)"
                    @dragend="onDragEnd"
                  >
                    <div class="field-card-row">
                      <!-- 这里用 label 只包住 checkbox 本身，不拖家带口 -->
                      <label class="field-checkbox-wrapper">
                        <input
                          type="checkbox"
                          v-model="fieldConfig[key].enabled"
                          draggable="false"
                          @pointerdown.stop
                          @dragstart.prevent
                        >
                      </label>
                      <span class="field-card-name" @click="toggleFieldEnabled(key)"><b>{{ fieldDefs[key].abbr }}</b> {{ fieldDefs[key].name }}</span>
                    </div>
                    <div class="field-card-row" v-if="key !== 'data'">
                      <span class="field-card-label">字节数</span>
                      <select
                        class="input byte-count-select"
                        :data-byte-count="key"
                        v-model="fieldConfig[key].byteCount"
                        draggable="false"
                        @pointerdown.stop
                        @dragstart.prevent
                      >
                        <option :value="1">1</option>
                        <option :value="2">2</option>
                        <option :value="3">3</option>
                        <option value="custom">自定义</option>
                      </select>
                      <input
                        type="number"
                        class="input byte-count-custom"
                        :data-byte-count-custom="key"
                        v-model.number="fieldConfig[key].customCount"
                        min="1" max="8"
                        :style="{ display: fieldConfig[key].byteCount === 'custom' ? 'block' : 'none' }"
                        draggable="false"
                        @pointerdown.stop
                        @dragstart.prevent
                      >
                    </div>
                    <div class="field-card-row" v-else>
                      <span class="field-card-hint">载荷长度随命令字变化，请前往「命令字配置」按命令设置</span>
                    </div>
                    <div class="field-card-row">
                      <span class="field-card-label">默认值</span>
                      <div
                        class="default-byte-boxes"
                        v-if="hasDefaults(key)"
                        :data-default-bytes="key"
                        draggable="false"
                        @pointerdown.stop
                        @dragstart.prevent
                      >
                        <input
                          v-for="di in getByteCount(key)"
                          :key="key + '-def-' + di"
                          type="text"
                          class="input default-byte-box"
                          :value="fieldConfig[key].defaults[di - 1] ?? ''"
                          maxlength="2"
                          placeholder="00"
                          @input="onDefaultByteInput(key, di - 1, $event)"
                          draggable="false"
                          @pointerdown.stop
                          @dragstart.prevent
                        >
                      </div>
                      <div class="default-byte-boxes empty" v-else>
                        <span class="default-byte-box-placeholder">—</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="form-row inline frame-global-row">
                <div>
                  <label>字节序</label>
                  <select class="input" v-model="endianness">
                    <option value="小端 (Little-Endian)">小端 (Little-Endian)</option>
                    <option value="大端 (Big-Endian)">大端 (Big-Endian)</option>
                  </select>
                </div>
                <div>
                  <label>校验 CHK 方式</label>
                  <select class="input" v-model="checkType">
                    <option v-for="ct in checkTypes" :key="ct" :value="ct">{{ ct }}</option>
                  </select>
                </div>
                <div>
                  <label>校验起始字节</label>
                  <select class="input" v-model="checkStartField">
                    <option v-for="f in checkFieldOptions" :key="f" :value="f">{{ f }}</option>
                  </select>
                </div>
                <div>
                  <label>校验结束字节</label>
                  <select class="input" v-model="checkEndField">
                    <option v-for="f in checkFieldOptions" :key="f" :value="f">{{ f }}</option>
                  </select>
                </div>
              </div>

              <div class="check-params-panel">
                <div
                  v-for="item in checkParamsList"
                  :key="item.type"
                  class="check-params-section"
                  v-show="checkType === item.type"
                  :data-check-type="item.type"
                >
                  <table class="check-params-table readonly" v-if="item.rows">
                    <thead>
                      <tr><th>参数名</th><th>参数值</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="(row, ri) in item.rows" :key="ri">
                        <td>{{ row[0] }}</td>
                        <td><span class="param-value">{{ row[1] }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                  <div class="check-example">
                    <div class="check-example-title">{{ item.exampleTitle || '算法示例（C 伪代码）' }}</div>
                    <div
                      class="check-code-wrapper"
                      :class="{ collapsed: !expandedCode[item.type], expandable: item.code && codeLineCount(item.code) > 3 }"
                    >
                      <pre v-if="item.code"><code>{{ item.code }}</code></pre>
                      <div class="check-example-note" v-else>{{ item.note }}</div>
                      <div
                        v-if="item.code && codeLineCount(item.code) > 3"
                        class="check-code-more"
                        @click="expandedCode[item.type] = !expandedCode[item.type]"
                      >
                        <span>{{ expandedCode[item.type] ? '收起' : '查看更多' }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 模块地址配置 -->
          <div class="panel collapsible" id="module-address-panel" :class="{ collapsed: panels.modules }">
            <div class="panel-header" data-collapse @click="panels.modules = !panels.modules">
              <h3>模块地址配置</h3>
              <button
                class="panel-toggle"
                type="button"
                title="收起/展开"
                @click.stop="panels.modules = !panels.modules"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
            </div>
            <div class="panel-body">
              <div class="module-address-toolbar">
                <button class="btn btn-secondary btn-small" @click="addModule">+ 添加模块</button>
                <button class="btn btn-danger btn-small" :disabled="selectedModuleIndex < 0" @click="deleteModule">删除选中模块</button>
              </div>
              <table class="data-table module-address-table">
                <thead>
                  <tr><th>模块名称</th><th>模块地址</th></tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(mod, i) in moduleAddresses"
                    :key="i"
                    :class="{ selected: i === selectedModuleIndex }"
                    @click="selectedModuleIndex = i"
                  >
                    <td>
                      <input type="text" class="input module-name-input" v-model="mod.name" @click.stop>
                    </td>
                    <td>
                      <div class="default-byte-boxes module-addr-boxes">
                        <input
                          v-for="(ab, ai) in mod.addressBytes"
                          :key="ai"
                          type="text"
                          class="input default-byte-box"
                          :value="ab"
                          maxlength="2"
                          placeholder="00"
                          @input="onAddressByteInput(mod, ai, $event)"
                          @click.stop
                        >
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 命令字配置 -->
          <div class="panel collapsible command-panel" id="command-panel" :class="{ collapsed: panels.commands, expanded: commandPanelExpanded }">
            <div class="panel-header" data-collapse @click="panels.commands = !panels.commands">
              <h3>命令字配置</h3>
              <button
                class="panel-header-btn expand-btn"
                type="button"
                :title="commandPanelExpanded ? '还原' : '放大'"
                @click.stop="toggleCommandPanelExpand"
              >
                <span class="expand-text" :class="{ expanded: commandPanelExpanded }">
                  {{ commandPanelExpanded ? '还原' : '放大' }}
                </span>
                <svg class="icon-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg>
                <svg class="icon-compress" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"/></svg>
              </button>
              <button
                class="panel-toggle"
                type="button"
                title="收起/展开"
                @click.stop="panels.commands = !panels.commands"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
            </div>
            <div class="panel-body">
              <div class="command-editor-layout">
                <div class="command-list">
                  <input type="text" class="input search" placeholder="搜索命令字..." v-model="commandSearch">
                  <div class="filter-tabs command-filters">
                    <button :class="['tab', { active: commandFilter === 'all' }]" @click="commandFilter = 'all'">全部</button>
                    <button :class="['tab', { active: commandFilter === 'tx' }]" @click="commandFilter = 'tx'">下发</button>
                    <button :class="['tab', { active: commandFilter === 'rx' }]" @click="commandFilter = 'rx'">上报</button>
                  </div>
                  <div class="command-cards">
                    <div
                      v-for="item in filteredCommandsWithIndex"
                      :key="item.originalIdx"
                      class="command-card"
                      :class="{ active: item.originalIdx === activeCommandIndex }"
                      @click="activeCommandIndex = item.originalIdx"
                      @mouseenter="onCmdHover($event, item.cmd)"
                      @mouseleave="hoveredCmd = null"
                    >
                      <div class="command-card-title"><code>{{ item.cmd.cmd }}</code> {{ item.cmd.name }}</div>
                      <div class="command-card-meta">
                        <span class="meta-box meta-sender">{{ item.cmd.sender }}</span>
                        <span class="meta-arrow"></span>
                        <span class="meta-box meta-receiver">{{ item.cmd.receiver }}</span>
                        <span class="meta-box meta-cycle">{{ item.cmd.cycle }}ms</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 帧报文悬浮窗（Teleport 到 body 避免被 overflow 裁剪） -->
                <Teleport to="body">
                  <div
                    v-if="hoveredCmd && hoveredFrame"
                    class="frame-tooltip-overlay"
                    :style="tooltipStyle"
                  >
                    <div class="frame-tooltip-title">完整帧报文示例</div>
                    <div class="frame-tooltip-body">
                      <template v-for="grp in hoveredFrame" :key="grp.key">
                        <div class="frame-tooltip-field" :class="'ft-' + grp.key">
                          <div class="ft-bytes">
                            <span v-for="(b, bi) in grp.bytes" :key="bi" class="ft-byte">{{ b }}</span>
                          </div>
                          <div class="ft-label">{{ grp.abbr }}</div>
                        </div>
                      </template>
                    </div>
                    <div class="frame-tooltip-hex">
                      {{ hoveredFrame.flatMap(g => g.bytes).join(' ') }}
                    </div>
                  </div>
                </Teleport>

                <div class="command-detail">
                  <div class="command-detail-header">
                    <h4>命令字详情</h4>
                    <div class="command-detail-actions">
                      <button class="btn btn-secondary btn-small" @click="addCommand">+ 新增命令字</button>
                      <button class="btn btn-danger btn-small" :disabled="!activeCommand" @click="deleteCommand">删除命令字</button>
                    </div>
                  </div>
                  <div v-if="activeCommand">
                  <div class="form-row inline">
                    <div class="cmd-code-group">
                      <label>命令码</label>
                      <div class="cmd-code-wrapper">
                        <div class="default-byte-boxes cmd-code-boxes">
                          <input
                            v-for="(cb, ci) in cmdByteInputs"
                            :key="ci"
                            type="text"
                            class="input default-byte-box"
                            :value="cb"
                            maxlength="2"
                            placeholder="00"
                            @input="onCmdByteInput(ci, $event)"
                          >
                        </div>
                      </div>
                    </div>
                    <div class="cmd-name-group">
                      <label>命令名称</label>
                      <input type="text" class="input cmd-name-input" v-model="activeCommand.name">
                    </div>
                  </div>
                  <div class="form-row inline">
                    <div>
                      <label>发送方</label>
                      <select class="input" v-model="activeCommand.sender">
                        <option v-for="mod in moduleAddresses" :key="mod.name" :value="mod.name">{{ mod.name }}</option>
                      </select>
                    </div>
                    <div>
                      <label>接收方</label>
                      <select class="input" v-model="activeCommand.receiver">
                        <option v-for="mod in moduleAddresses" :key="mod.name" :value="mod.name">{{ mod.name }}</option>
                      </select>
                    </div>
                    <div><label>周期 (ms)</label><input type="number" class="input" v-model="activeCommand.cycle" min="0"></div>
                  </div>
                  <div class="form-row inline payload-len-row">
                    <div>
                      <label>载荷模式</label>
                      <select class="input" style="width:auto" :value="activeCommand.payloadMode || 'fixed'" @change="onPayloadModeChange">
                        <option value="fixed">固定长度</option>
                        <option value="varlen">变长 (LEN字段)</option>
                      </select>
                    </div>
                    <div v-if="activeCommand.payloadMode !== 'varlen'">
                      <label>载荷字节数</label>
                      <div class="payload-len-inline">
                        <input
                          type="number"
                          class="input payload-len-input"
                          :value="getCmdPayloadLen(activeCommand)"
                          min="0" :max="payloadLenMax"
                          @change="onPayloadLenChange"
                        >
                        <span class="payload-usage-note">上限 {{ payloadLenMax }} 字节，已用 {{ getFieldBytesTotal(activeCommand.fields) }} 字节</span>
                      </div>
                    </div>
                    <div v-else>
                      <label>载荷长度</label>
                      <span class="payload-usage-note">变长模式：运行时从 LEN 字段读取实际字节数（上限 {{ payloadLenMax }}）</span>
                    </div>
                  </div>
                  <div class="section-header-row" style="margin-top:12px">
                    <div class="section-title">字段列表</div>
                    <div class="section-actions">
                      <button class="btn btn-secondary btn-small" @click="addField">+ 添加字段</button>
                      <button class="btn btn-danger btn-small" :disabled="selectedFieldIndex < 0" @click="deleteField">删除字段</button>
                    </div>
                  </div>
                  <table class="data-table command-field-table">
                    <thead>
                      <tr><th class="field-drag-col"></th><th>字段名</th><th>类型</th><th>配置</th><th class="field-order-col"></th></tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(field, fi) in activeCommand.fields"
                        :key="fi"
                        :class="{ selected: fi === selectedFieldIndex, 'drag-over': dragOverFieldIndex === fi }"
                        draggable="true"
                        @dragstart="onFieldDragStart(fi, $event)"
                        @dragover.prevent="onFieldDragOver(fi)"
                        @dragleave="onFieldDragLeave"
                        @drop.prevent="onFieldDrop(fi)"
                        @dragend="onFieldDragEnd"
                        @click="selectedFieldIndex = fi"
                      >
                        <td class="field-drag-col">
                          <span class="field-drag-handle" title="拖拽调整字段顺序">⠿</span>
                        </td>
                        <td>
                          <input type="text" class="input field-name-input" v-model="field.name" @click.stop>
                        </td>
                        <td>
                          <select
                            class="input field-type-select"
                            v-model="field.type"
                            @change="onFieldTypeChange(field)"
                            @click.stop
                          >
                            <option value="bitfield">位域解析</option>
                            <option value="enum">枚举映射</option>
                            <option value="raw">原始数值</option>
                            <option value="number">多字节整数</option>
                            <option value="text">文本/JSON</option>
                            <option value="binary">二进制段</option>
                          </select>
                        </td>
                        <td>
                          <div class="command-field-config" @click.stop>
                            <!-- 位域解析 -->
                            <div v-if="field.type === 'bitfield'" class="bit-field-grid">
                              <div class="bit-field-item" v-for="(bit, bi) in field.bits" :key="bi">
                                <label>Bit{{ bit.bit }}</label>
                                <input type="text" class="input" placeholder="0含义" v-model="bit.zero">
                                <input type="text" class="input" placeholder="1含义" v-model="bit.one">
                              </div>
                            </div>
                            <!-- 枚举映射 -->
                            <div v-else-if="field.type === 'enum'" class="enum-list">
                              <div class="enum-item" v-for="(ei, eidx) in field.enumItems" :key="eidx">
                                <input
                                  type="text"
                                  class="input enum-value-box"
                                  :value="ei.value"
                                  maxlength="2"
                                  placeholder="00"
                                  @input="onEnumValueInput(field, eidx, $event)"
                                >
                                <input type="text" class="input" v-model="ei.meaning" placeholder="含义">
                                <button class="btn btn-danger btn-small" type="button" @click="field.enumItems.splice(eidx, 1)">删除</button>
                              </div>
                              <button class="btn btn-secondary btn-small" type="button" @click="addEnumItem(field)">+ 枚举值</button>
                            </div>
                            <!-- 原始数值 -->
                            <div v-else-if="field.type === 'raw'" class="field-config-row">
                              <span class="field-config-label">默认值</span>
                              <input
                                type="text"
                                class="input default-byte-box"
                                :value="field.rawValue"
                                maxlength="2"
                                placeholder="00"
                                @input="onRawValueInput(field, $event)"
                              >
                            </div>
                            <!-- 多字节整数 -->
                            <div v-else-if="field.type === 'number'" class="field-config-row" style="flex-wrap:wrap;gap:6px">
                              <select class="input" style="width:auto" v-model="field.encoding" @change="onNumberEncodingChange(field)">
                                <option value="uint8">uint8 (1B)</option>
                                <option value="int8">int8 (1B)</option>
                                <option value="uint16">uint16 (2B)</option>
                                <option value="int16">int16 (2B)</option>
                                <option value="uint32">uint32 (4B)</option>
                                <option value="int32">int32 (4B)</option>
                                <option value="float32">float32 (4B)</option>
                                <option value="float64">float64 (8B)</option>
                              </select>
                              <input type="number" class="input" style="width:70px" v-model="field.scale" step="0.1" title="缩放系数: 物理值 = 原始值 × scale">
                              <input type="text" class="input" style="width:50px" v-model="field.unit" placeholder="单位" title="物理单位">
                            </div>
                            <!-- 文本/JSON -->
                            <div v-else-if="field.type === 'text'" class="field-config-row" style="flex-wrap:wrap;gap:6px">
                              <select class="input" style="width:auto" v-model="field.lengthMode">
                                <option value="varlen-field">长度引用</option>
                                <option value="varlen-delim">分隔符</option>
                                <option value="varlen-rest">到帧尾</option>
                                <option value="fixed">固定长度</option>
                              </select>
                              <select v-if="field.lengthMode === 'varlen-field'" class="input" style="width:auto" v-model="field.lengthField">
                                <option value="len">LEN 字段</option>
                              </select>
                              <input v-if="field.lengthMode === 'fixed'" type="number" class="input" style="width:60px" v-model="field.length" min="1">
                              <input v-if="field.lengthMode === 'varlen-delim'" type="text" class="input" style="width:80px" v-model="field.delimiter" placeholder="0D0A" title="分隔符(HEX)">
                              <select class="input" style="width:auto" v-model="field.encoding">
                                <option value="utf8">UTF-8</option>
                                <option value="ascii">ASCII</option>
                                <option value="gbk">GBK</option>
                              </select>
                              <select class="input" style="width:auto" v-model="field.format">
                                <option value="raw">原始文本</option>
                                <option value="json">JSON 解析</option>
                              </select>
                            </div>
                            <!-- 二进制段 -->
                            <div v-else-if="field.type === 'binary'" class="field-config-row" style="flex-wrap:wrap;gap:6px">
                              <select class="input" style="width:auto" v-model="field.lengthMode">
                                <option value="varlen-field">长度引用</option>
                                <option value="varlen-delim">分隔符</option>
                                <option value="varlen-rest">到帧尾</option>
                                <option value="fixed">固定长度</option>
                              </select>
                              <select v-if="field.lengthMode === 'varlen-field'" class="input" style="width:auto" v-model="field.lengthField">
                                <option value="len">LEN 字段</option>
                              </select>
                              <input v-if="field.lengthMode === 'fixed'" type="number" class="input" style="width:60px" v-model="field.length" min="1">
                              <input v-if="field.lengthMode === 'varlen-delim'" type="text" class="input" style="width:80px" v-model="field.delimiter" placeholder="0D0A" title="分隔符(HEX)">
                              <select class="input" style="width:auto" v-model="field.encoding">
                                <option value="hex">HEX 显示</option>
                                <option value="base64">Base64</option>
                              </select>
                            </div>
                          </div>
                        </td>
                        <td class="field-order-col">
                          <div class="field-order-btns">
                            <button
                              class="btn btn-secondary btn-small field-order-btn"
                              :disabled="fi === 0"
                              title="上移"
                              @click.stop="moveField(fi, -1)"
                            >↑</button>
                            <button
                              class="btn btn-secondary btn-small field-order-btn"
                              :disabled="fi === activeCommand.fields.length - 1"
                              title="下移"
                              @click.stop="moveField(fi, 1)"
                            >↓</button>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  </div>
                  <div v-else class="command-detail-empty">
                    <span>暂无命令字，点击「+ 新增命令字」添加</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- 审核人选人弹窗 -->
    <Transition name="modal-fade">
      <div v-if="reviewerDialog.show" class="modal-overlay" @click.self="cancelSubmitReview">
        <div class="modal-dialog reviewer-dialog">
          <div class="modal-header">
            <h3>指定审核人</h3>
          </div>
          <div class="modal-body">
            <p style="margin-bottom:12px;color:var(--text-secondary);">协议「<b>{{ reviewerDialog.proto?.name }}</b>」：选择负责审核此协议变更的人员：</p>
            <div class="reviewer-list">
              <div
                v-for="c in reviewerDialog.candidates"
                :key="c.id"
                class="reviewer-item"
                :class="{ selected: reviewerDialog.selectedUser === c }"
                @click="reviewerDialog.selectedUser = c"
              >
                <div class="user-avatar">{{ (c.name).slice(0, 2).toUpperCase() }}</div>
                <div class="reviewer-info">
                  <span class="reviewer-name">{{ c.name }}</span>
                  <span class="reviewer-role">{{ [c.department, c.module].filter(Boolean).join(' · ') || '—' }}</span>
                </div>
                <span v-if="reviewerDialog.selectedUser === c" class="reviewer-check">✓</span>
              </div>
              <div v-if="reviewerDialog.candidates.length === 0" class="reviewer-empty">
                暂无可选审核人
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="cancelSubmitReview">取消</button>
            <button class="btn btn-primary" :disabled="!reviewerDialog.selectedUser" @click="confirmSubmitReview">确认提交</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 右键上下文菜单 -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="ctx-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="ctx-menu-item" @click="openArchiveDialog(contextMenu.proto)">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h10v8H2z"/><path d="M4 4V2h6v2"/><path d="M5 8h4"/></svg>
          <span>归档到项目</span>
        </div>
        <div v-if="contextMenu.proto && contextMenu.proto.project" class="ctx-menu-item" @click="removeFromProject(contextMenu.proto)">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h8"/><path d="M7 6v6"/><path d="M3 6l1-3h4l1 3"/></svg>
          <span>移出项目</span>
        </div>
      </div>
    </Teleport>

    <!-- 归档到项目弹窗 -->
    <Transition name="modal">
      <div v-if="archiveDialog.visible" class="modal-overlay" @click="closeArchiveDialog">
        <div class="modal-dialog archive-dialog" @click.stop>
          <div class="modal-header">
            <h3>归档协议到项目</h3>
            <button class="modal-close" @click="closeArchiveDialog" title="关闭">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-close" /></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="archive-proto-info">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-file-text" /></svg>
              <span>{{ archiveDialog.protoName }}</span>
            </div>
            <div class="archive-section-label">选择已有项目</div>
            <div class="archive-project-list">
              <div
                v-for="proj in projectList"
                :key="proj"
                class="archive-project-item"
                :class="{ active: archiveDialog.selectedProject === proj && !archiveDialog.newProjectName }"
                @click="archiveDialog.selectedProject = proj; archiveDialog.newProjectName = ''"
              >
                <span class="proj-color-dot" :style="{ background: projectColorMap[proj] || '#3b82f6' }" @click.stop="editingProjectColor = editingProjectColor === proj ? '' : proj" title="点击修改颜色"></span>
                <div v-if="editingProjectColor === proj" class="inline-color-picker" @click.stop>
                  <button
                    v-for="c in PROJECT_COLORS"
                    :key="c"
                    class="color-dot sm"
                    :class="{ selected: (projectColorMap[proj] || '#3b82f6') === c }"
                    :style="{ background: c }"
                    @click="updateProjectColor(proj, c)"
                  ></button>
                  <label class="color-dot sm more-color" title="更多颜色">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10M7 12h10M7 17h6"/><circle cx="12" cy="12" r="10"/></svg>
                    <input type="color" :value="projectColorMap[proj] || '#3b82f6'" @input="updateProjectColor(proj, $event.target.value)">
                  </label>
                </div>
                <span>{{ proj }}</span>
                <svg v-if="archiveDialog.selectedProject === proj && !archiveDialog.newProjectName" width="14" height="14" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8l3 3 7-7"/></svg>
              </div>
              <div v-if="projectList.length === 0" class="archive-empty">
                <span>暂无项目，在下方输入名称创建新项目</span>
              </div>
            </div>
            <div class="archive-new-btn-wrap" v-if="!archiveDialog.creatingNew">
              <button class="btn btn-secondary archive-new-btn" @click="archiveDialog.creatingNew = true">
                新建项目
              </button>
            </div>
            <div class="archive-input-wrap" v-else>
              <input type="text" class="input archive-input" v-model="archiveDialog.newProjectName" placeholder="输入新项目名称" ref="newProjectInput" @keyup.enter="confirmArchive">
              <div class="color-picker-row">
                <span class="color-picker-label">颜色标签</span>
                <div class="color-picker">
                  <button
                    v-for="c in PROJECT_COLORS"
                    :key="c"
                    class="color-dot"
                    :class="{ selected: archiveDialog.newProjectColor === c }"
                    :style="{ background: c }"
                    @click="archiveDialog.newProjectColor = c"
                  ></button>
                </div>
              </div>
              <span v-if="archiveDialog.newProjectName.trim()" class="archive-input-hint">将归档到 "{{ archiveDialog.newProjectName.trim() }}"</span>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closeArchiveDialog">取消</button>
            <button class="btn btn-primary" :disabled="!effectiveSelectedProject" @click="confirmArchive">确认归档</button>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import { useReviewQueue } from '../composables/useReviewQueue';
import { useCurrentUser } from '../composables/useCurrentUser';

/* ===================== 共享审核队列 ===================== */
const { submitReview, publishReview, reviewQueue, isLoaded: reviewLoaded } = useReviewQueue();

/**
 * 根据审核队列同步每个协议的最新审核状态
 * 当审核队列变化时（如驳回、通过、发布），同步更新协议列表中的 reviewStatus
 * 跳过 draftDirty 的协议：本地草稿在最后一次审核提交之后又改过，
 * 旧审核记录（已通过/已生效）已不代表当前草稿内容，状态应保持"待提交"
 */
function syncReviewStatusToProtocols() {
  if (!protocolList.value || protocolList.value.length === 0) return;
  const latestByProtocol = new Map();
  for (const item of reviewQueue.value) {
    if (!latestByProtocol.has(item.title)) {
      latestByProtocol.set(item.title, { status: item.status, changeId: item.changeId });
    }
  }
  for (const proto of protocolList.value) {
    if (proto.draftDirty) continue;
    const latest = latestByProtocol.get(proto.name);
    if (latest) {
      proto.reviewStatus = latest.status;
      proto.changeId = latest.changeId;
    }
  }
}

/* 审核队列变化时同步更新协议的审核状态 */
watch(reviewQueue, () => {
  syncReviewStatusToProtocols();
}, { deep: true });

/* ===================== 当前用户 ===================== */
const { currentUser, getReviewCandidates, loadKnownUsers, isLoaded } = useCurrentUser();

/* ===================== Electron API 检测 ===================== */
const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';

/* 是否远程模式（连接团队服务器） */
const isRemoteMode = ref(false);
async function checkRemoteMode() {
  if (!hasElectron || !window.electronAPI.dbConfig) {
    isRemoteMode.value = false;
    return;
  }
  try {
    const cfg = await window.electronAPI.dbConfig.get();
    isRemoteMode.value = cfg && cfg.mode === 'remote' && /^https?:\/\//.test(cfg.url || '');
  } catch {
    isRemoteMode.value = false;
  }
}

/* ===================== 右键上下文菜单 ===================== */
const contextMenu = reactive({ visible: false, x: 0, y: 0, proto: null });

function onProtocolContextMenu(e, proto) {
  contextMenu.visible = true;
  contextMenu.x = e.clientX;
  contextMenu.y = e.clientY;
  contextMenu.proto = proto;
  /* 全局点击关闭菜单 */
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  contextMenu.visible = false;
  contextMenu.proto = null;
}

/* ===================== 项目归档 ===================== */
const projectList = ref([]);
const projectColorMap = ref({});
const PROJECT_COLORS = [
  '#3b82f6', '#22c55e', '#a855f7', '#f59e0b',
  '#ec4899', '#06b6d4', '#6366f1', '#ef4444',
];
const archiveDialog = reactive({
  visible: false,
  proto: null,
  protoName: '',
  selectedProject: '',
  newProjectName: '',
  newProjectColor: PROJECT_COLORS[0],
  creatingNew: false,
});
const editingProjectColor = ref('');

async function loadProjectList() {
  if (!hasElectron) return;
  try {
    const result = await window.electronAPI.db.query(
      'SELECT name, color FROM projects ORDER BY name',
    );
    if (result.success && result.rows) {
      projectList.value = result.rows.map(r => r.name);
      const map = {};
      for (const r of result.rows) {
        map[r.name] = r.color || '#3b82f6';
      }
      projectColorMap.value = map;
    }
  } catch { /* ignore */ }
}

function openArchiveDialog(proto) {
  closeContextMenu();
  if (!proto) return;
  archiveDialog.proto = proto;
  archiveDialog.protoName = proto.name === activeProtocol.value ? protoName.value : proto.name;
  archiveDialog.selectedProject = proto.project || '';
  archiveDialog.newProjectName = '';
  archiveDialog.visible = true;
  loadProjectList();
}

function closeArchiveDialog() {
  archiveDialog.visible = false;
  archiveDialog.proto = null;
  archiveDialog.creatingNew = false;
  archiveDialog.newProjectName = '';
  archiveDialog.newProjectColor = PROJECT_COLORS[0];
  archiveDialog.selectedProject = '';
  editingProjectColor.value = '';
}

async function updateProjectColor(projName, color) {
  if (!hasElectron) return;
  try {
    await window.electronAPI.db.execute(
      'UPDATE projects SET color = ? WHERE name = ?',
      [color, projName],
    );
    projectColorMap.value[projName] = color;
  } catch { /* ignore */ }
  editingProjectColor.value = '';
}

function selectNewProject() {
  const name = archiveDialog.newProjectName.trim();
  if (!name) return;
  archiveDialog.selectedProject = name;
  archiveDialog.newProjectName = '';
}

/* 输入新项目名时自动选中，否则使用已选项目 */
const effectiveSelectedProject = computed(() => {
  const newName = archiveDialog.newProjectName.trim();
  if (newName) return newName;
  return archiveDialog.selectedProject;
});

async function confirmArchive() {
  const proj = effectiveSelectedProject.value;
  if (!proj || !archiveDialog.proto) return;
  const proto = archiveDialog.proto;
  /* 获取协议真实名称（编辑中的协议可能名称已改） */
  const realName = proto.name === activeProtocol.value ? protoName.value : proto.name;

  /* 如果没有 dbId，尝试按名称从数据库查找 */
  let dbId = proto.dbId;
  if (!dbId && hasElectron) {
    try {
      const result = await window.electronAPI.db.query(
        'SELECT id FROM protocols WHERE name = ?',
        [realName],
      );
      if (result.success && result.rows && result.rows.length > 0) {
        dbId = result.rows[0].id;
        proto.dbId = dbId;
      }
    } catch { /* ignore */ }
  }

  /* 将项目写入 projects 表（幂等，INSERT OR IGNORE） */
  if (hasElectron) {
    try {
      await window.electronAPI.db.execute(
        'INSERT OR IGNORE INTO projects (name, color) VALUES (?, ?)',
        [proj, archiveDialog.newProjectColor],
      );
    } catch { /* ignore */ }
  }

  /* 更新数据库：协议绑定到项目 */
  if (dbId && hasElectron) {
    try {
      await window.electronAPI.db.execute(
        'UPDATE protocols SET project = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
        [proj, dbId],
      );
    } catch { /* ignore */ }
  }

  /* 更新内存 */
  proto.project = proj;
  closeArchiveDialog();

  /* 刷新项目列表 */
  await loadProjectList();
}

async function removeFromProject(proto) {
  closeContextMenu();
  if (!proto) return;
  let dbId = proto.dbId;
  /* 同样兜底查找 */
  if (!dbId && hasElectron) {
    const realName = proto.name === activeProtocol.value ? protoName.value : proto.name;
    try {
      const result = await window.electronAPI.db.query(
        'SELECT id FROM protocols WHERE name = ?',
        [realName],
      );
      if (result.success && result.rows && result.rows.length > 0) {
        dbId = result.rows[0].id;
        proto.dbId = dbId;
      }
    } catch { /* ignore */ }
  }
  if (dbId && hasElectron) {
    try {
      await window.electronAPI.db.execute(
        'UPDATE protocols SET project = \'\', updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
        [dbId],
      );
    } catch { /* ignore */ }
  }
  proto.project = '';
  await loadProjectList();
}

/* 按项目筛选 */
const projectFilter = ref('');
function filterByProject(project) {
  if (projectFilter.value === project) {
    projectFilter.value = '';
  } else {
    projectFilter.value = project;
  }
}

/* ===================== 面板折叠状态 ===================== */
const panels = reactive({
  basic: false,
  frame: false,
  modules: false,
  commands: false,
});
const commandPanelExpanded = ref(false);

/**
 * 展开/还原命令字面板。
 * 展开面板是 absolute inset:0 遮罩，锚定在 .view（定位祖先）的滚动内容原点：
 * 展开时必须把视图与编辑器滚动复位（配合 .cmd-expanded 冻结滚动），
 * 否则遮罩顶部（含「还原」按钮）停在已滚出屏幕的位置，且无法滚回。
 */
function toggleCommandPanelExpand() {
  commandPanelExpanded.value = !commandPanelExpanded.value;
  if (commandPanelExpanded.value) {
    nextTick(() => {
      document.querySelector('#view-protocols')?.scrollTo(0, 0);
      document.querySelector('.protocol-editor-body')?.scrollTo(0, 0);
    });
  }
}

/* 算法示例代码展开状态：每个校验类型独立控制 */
const expandedCode = reactive({});

/**
 * 计算代码行数
 * @param {string} code - 代码字符串
 * @returns {number} 行数
 */
function codeLineCount(code) {
  if (!code) return 0;
  return code.split('\n').length;
}

/* ===================== Toast 提示 ===================== */
const toast = reactive({
  show: false,
  type: 'success',
  message: '',
  timer: null,
});

/**
 * 显示 Toast 提示
 * @param {string} message - 提示内容
 * @param {string} type - 'success' | 'error'
 * @param {number} duration - 显示时长（ms）
 */
function showToast(message, type = 'success', duration = 2500) {
  if (toast.timer) clearTimeout(toast.timer);
  toast.message = message;
  toast.type = type;
  toast.show = true;
  toast.timer = setTimeout(() => { toast.show = false; }, duration);
}

/* ===================== 未保存变更追踪 ===================== */
const savedSnapshot = ref(null);

/* 乐观锁：编辑器当前加载的协议在数据库中的 id（DELETE+INSERT 每次保存生成新 id，天然单调递增） */
const editorLoadedProtoId = ref(null);
const dontAskAgain = ref(false);
const unsavedDialog = reactive({
  show: false,
  fromName: '',
  toName: '',
  pendingProto: null,
});

/**
 * 当前版本字符串
 */
const currentVersion = computed(() => {
  return `v${versionMajor.value}.${versionMinor.value}.${versionPatch.value}`;
});

/**
 * 检测当前编辑器是否有未保存的变更
 * 通过对比当前状态与上次保存的快照
 */
const hasUnsavedChanges = computed(() => {
  if (!savedSnapshot.value) return false;
  const current = captureEditorState();
  return JSON.stringify(current) !== JSON.stringify(savedSnapshot.value);
});

/* ===================== 基本信息 ===================== */
const protoName = ref('自定义传感器协议 V3');
const protoDesc = ref('用于多传感器节点数据采集与控制。');
const versionMajor = ref(3);
const versionMinor = ref(2);
const versionPatch = ref(1);

/* ===================== 协议列表 ===================== */

/**
 * 捕获当前编辑器的完整状态快照
 * @returns {object} 包含所有编辑器字段的配置对象
 */
function captureEditorState() {
  return {
    protoName: protoName.value,
    protoDesc: protoDesc.value,
    versionMajor: versionMajor.value,
    versionMinor: versionMinor.value,
    versionPatch: versionPatch.value,
    fieldOrder: [...fieldOrder.value],
    fieldConfig: JSON.parse(JSON.stringify(fieldConfig)),
    endianness: endianness.value,
    checkType: checkType.value,
    checkStartField: checkStartField.value,
    checkEndField: checkEndField.value,
    moduleAddresses: JSON.parse(JSON.stringify(moduleAddresses.value)),
    commands: JSON.parse(JSON.stringify(commands.value)),
  };
}

/**
 * 从配置快照恢复编辑器状态
 * @param {object} config - 之前保存的配置快照
 */
function restoreEditorState(config) {
  protoName.value = config.protoName;
  protoDesc.value = config.protoDesc;
  versionMajor.value = config.versionMajor;
  versionMinor.value = config.versionMinor;
  versionPatch.value = config.versionPatch;
  fieldOrder.value = [...config.fieldOrder];
  /* 深拷贝 fieldConfig，逐字段恢复以保持响应性 */
  for (const key of fieldOrder.value) {
    if (config.fieldConfig[key]) {
      fieldConfig[key].enabled = config.fieldConfig[key].enabled;
      fieldConfig[key].byteCount = config.fieldConfig[key].byteCount;
      fieldConfig[key].customCount = config.fieldConfig[key].customCount;
      fieldConfig[key].defaults = [...config.fieldConfig[key].defaults];
    }
  }
  endianness.value = config.endianness;
  checkType.value = config.checkType;
  checkStartField.value = config.checkStartField;
  checkEndField.value = config.checkEndField;
  moduleAddresses.value = JSON.parse(JSON.stringify(config.moduleAddresses));
  commands.value = JSON.parse(JSON.stringify(config.commands));
  /* 旧快照命令无 payloadLen 时按帧格式 DATA 历史全局字节数补齐 */
  commands.value.forEach(c => {
    if (c.payloadLen == null) c.payloadLen = getCmdPayloadLen(c);
    /* 旧数据默认 fixed 模式，新数据可能带 varlen */
    if (!c.payloadMode) c.payloadMode = 'fixed';
    /* 旧字段无 length 属性，默认 1 字节 */
    if (c.fields) c.fields.forEach(f => {
      if (!f.length && !f.lengthMode) f.length = 1;
    });
  });
  selectedModuleIndex.value = -1;
  activeCommandIndex.value = commands.value.length > 0 ? 0 : -1;
  selectedFieldIndex.value = -1;
}

/* 默认编辑器状态：用于新建协议和初始协议配置 */
function defaultEditorState(name) {
  return {
    protoName: name,
    protoDesc: '',
    versionMajor: 1,
    versionMinor: 0,
    versionPatch: 0,
    fieldOrder: ['sof', 'src', 'dst', 'ver', 'cmd', 'ctr', 'seq', 'tid', 'len', 'data', 'chk', 'eof'],
    fieldConfig: {
      sof:  { enabled: true,  byteCount: 2, customCount: 2, defaults: ['AA', '55'] },
      src:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['01'] },
      dst:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['FF'] },
      ver:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['03'] },
      cmd:  { enabled: true,  byteCount: 1, customCount: 1, defaults: ['01'] },
      ctr:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
      seq:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
      tid:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
      len:  { enabled: true,  byteCount: 1, customCount: 1, defaults: [] },
      data: { enabled: true,  byteCount: 2, customCount: 2, defaults: [] },
      chk:  { enabled: true,  byteCount: 2, customCount: 2, defaults: [] },
      eof:  { enabled: true,  byteCount: 2, customCount: 2, defaults: ['0D', '0A'] },
    },
    endianness: '小端 (Little-Endian)',
    checkType: 'CRC16-MODBUS',
    checkStartField: 'SOF',
    checkEndField: 'DATA',
    moduleAddresses: [{ name: '主控制器', addressBytes: ['01'] }],
    commands: [{
      cmd: '0x01', cmdBytes: ['01'], name: '新命令',
      sender: '主控制器', receiver: '主控制器', dir: 'tx', cycle: '0', fields: [],
      payloadLen: 2,
    }],
  };
}

/* 按项目筛选后的协议列表 */
const filteredProtocols = computed(() => {
  if (!projectFilter.value) return protocolList.value;
  return protocolList.value.filter(p => p.project === projectFilter.value);
});

/* 协议按项目分组 */
const collapsedGroups = reactive({});
function toggleGroup(name) {
  collapsedGroups[name] = !collapsedGroups[name];
}
/* 协议列表面板整体折叠（点击面板标题旁的箭头或标题） */
const listCollapsed = ref(false);
/* 折叠态：全部协议的首字圆头像（按分组顺序，保留分组色） */
const flatProtocols = computed(() =>
  groupedProtocols.value.flatMap(g => g.protos.map(p => ({ ...p, groupColor: g.color }))),
);
const groupedProtocols = computed(() => {
  const groups = {};
  for (const proto of filteredProtocols.value) {
    const proj = proto.project || '未归档';
    if (!groups[proj]) groups[proj] = [];
    groups[proj].push(proto);
  }
  return Object.entries(groups).map(([name, protos]) => ({
    name,
    protos,
    color: name === '未归档' ? '#6b7280' : (projectColorMap.value[name] || '#3b82f6'),
  }));
});

/* 初始仅保留一条默认协议 */
const protocolList = ref([
  {
    uid: 1, name: '自定义传感器协议 V3', status: '已启用', draft: false, version: 'v3.2.1', reviewStatus: null,
    config: {
      protoName: '自定义传感器协议 V3',
      protoDesc: '用于多传感器节点数据采集与控制。',
      versionMajor: 3, versionMinor: 2, versionPatch: 1,
      fieldOrder: ['sof', 'src', 'dst', 'ver', 'cmd', 'ctr', 'seq', 'tid', 'len', 'data', 'chk', 'eof'],
      fieldConfig: {
        sof:  { enabled: true,  byteCount: 2, customCount: 2, defaults: ['AA', '55'] },
        src:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['01'] },
        dst:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['FF'] },
        ver:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['03'] },
        cmd:  { enabled: true,  byteCount: 1, customCount: 1, defaults: ['01'] },
        ctr:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
        seq:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
        tid:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
        len:  { enabled: true,  byteCount: 1, customCount: 1, defaults: [] },
        data: { enabled: true,  byteCount: 2, customCount: 2, defaults: [] },
        chk:  { enabled: true,  byteCount: 2, customCount: 2, defaults: [] },
        eof:  { enabled: true,  byteCount: 2, customCount: 2, defaults: ['0D', '0A'] },
      },
      endianness: '小端 (Little-Endian)',
      checkType: 'CRC16-MODBUS',
      checkStartField: 'SOF',
      checkEndField: 'DATA',
      moduleAddresses: [
        { name: '主控制器', addressBytes: ['01'] },
        { name: '传感器节点 A', addressBytes: ['10'] },
        { name: '传感器节点 B', addressBytes: ['11'] },
      ],
      commands: [
        { cmd: '0x01', cmdBytes: ['01'], name: '查询传感器数据', sender: '主控制器', receiver: '传感器节点 A', dir: 'tx', cycle: '500', payloadLen: 3, fields: [
          { name: '状态字', type: 'bitfield', bits: Array.from({ length: 8 }, (_, i) => ({ bit: i, zero: '', one: '' })) },
          { name: '错误码', type: 'enum', enumItems: [
            { value: '00', meaning: '正常' },
            { value: '01', meaning: '超时' },
            { value: '02', meaning: '校验错误' },
          ] },
          { name: '温度低字节', type: 'raw', rawValue: '00' },
        ] },
        { cmd: '0x81', cmdBytes: ['81'], name: '上报传感器数据', sender: '传感器节点 A', receiver: '主控制器', dir: 'rx', cycle: '0', payloadLen: 1, fields: [
          { name: '温度', type: 'raw', rawValue: '00' },
        ] },
        { cmd: '0x02', cmdBytes: ['02'], name: '设置采样周期', sender: '主控制器', receiver: '传感器节点 A', dir: 'tx', cycle: '300', payloadLen: 1, fields: [
          { name: '周期', type: 'raw', rawValue: '64' },
        ] },
        { cmd: '0x03', cmdBytes: ['03'], name: '复位设备', sender: '主控制器', receiver: '传感器节点 A', dir: 'tx', cycle: '1000', payloadLen: 0, fields: [] },
      ],
    },
  },
]);
const activeProtocol = ref('自定义传感器协议 V3');

/* ===================== 字段定义 ===================== */
const fieldOrder = ref([
  'sof', 'src', 'dst', 'ver', 'cmd', 'ctr', 'seq', 'tid', 'len', 'data', 'chk', 'eof',
]);
const fieldDefs = {
  sof:  { abbr: 'SOF',  name: '帧头' },
  src:  { abbr: 'SRC',  name: '源地址' },
  dst:  { abbr: 'DST',  name: '目标地址' },
  ver:  { abbr: 'VER',  name: '协议版本' },
  cmd:  { abbr: 'CMD',  name: '命令字' },
  ctr:  { abbr: 'CTR',  name: '帧控制' },
  seq:  { abbr: 'SEQ',  name: '帧序号' },
  tid:  { abbr: 'TID',  name: '事务ID' },
  len:  { abbr: 'LEN',  name: '载荷长度' },
  data: { abbr: 'DATA', name: '载荷数据' },
  chk:  { abbr: 'CHK',  name: '校验' },
  eof:  { abbr: 'EOF',  name: '帧尾' },
};
const previewLabels = {
  sof: '帧头', src: '源地址', dst: '目标地址', ver: '版本',
  cmd: 'CMD', ctr: '控制', seq: '序号', tid: '事务',
  len: '长度', data: '数据', chk: '校验', eof: '帧尾',
};
const fieldsWithoutDefaults = ['len', 'data', 'chk'];
function hasDefaults(key) {
  return !fieldsWithoutDefaults.includes(key);
}

const fieldConfig = reactive({
  sof:  { enabled: true,  byteCount: 2, customCount: 2, defaults: ['AA', '55'] },
  src:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['01'] },
  dst:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['FF'] },
  ver:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['03'] },
  cmd:  { enabled: true,  byteCount: 1, customCount: 1, defaults: ['01'] },
  ctr:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
  seq:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
  tid:  { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
  len:  { enabled: true,  byteCount: 1, customCount: 1, defaults: [] },
  data: { enabled: true,  byteCount: 2, customCount: 2, defaults: [] },
  chk:  { enabled: true,  byteCount: 2, customCount: 2, defaults: [] },
  eof:  { enabled: true,  byteCount: 2, customCount: 2, defaults: ['0D', '0A'] },
});

function getByteCount(key) {
  const cfg = fieldConfig[key];
  if (cfg.byteCount === 'custom') return cfg.customCount || 1;
  return cfg.byteCount;
}

/**
 * 载荷字节数上限：由帧格式 LEN 字段可表示的最大值决定
 * LEN N 字节 → 256^N - 1；LEN 未启用时默认 255
 */
const payloadLenMax = computed(() => {
  const lenCfg = fieldConfig.len;
  if (!lenCfg || !lenCfg.enabled) return 255;
  const n = getByteCount('len');
  const max = Math.pow(256, n) - 1;
  return max > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : max;
});

/**
 * 命令的载荷字节数：每个命令独立配置（payloadLen），
 * 旧快照无该字段时回退到帧格式 DATA 字段的历史全局字节数；
 * 超出 LEN 可表示范围时按上限取值
 */
function getCmdPayloadLen(cmd) {
  if (cmd && Number.isFinite(+cmd.payloadLen) && +cmd.payloadLen >= 0) {
    return Math.min(payloadLenMax.value, Math.floor(+cmd.payloadLen));
  }
  return getByteCount('data');
}

/**
 * 载荷字节数变更：钳制到 0~LEN 上限，且不允许小于已定义的字段数
 */
function onPayloadLenChange(event) {
  if (!activeCommand.value) return;
  const raw = parseInt(event.target.value, 10);
  const usedBytes = getFieldBytesTotal(activeCommand.value.fields);
  if (isNaN(raw)) {
    event.target.value = getCmdPayloadLen(activeCommand.value);
    return;
  }
  const max = payloadLenMax.value;
  const clamped = Math.max(0, Math.min(max, raw));
  if (clamped < raw) {
    showToast(`载荷字节数超出 LEN 可表示范围（0~${max}）`, 'error');
  }
  if (clamped < usedBytes) {
    showToast(`字段已占用 ${usedBytes} 字节，载荷字节数不能小于 ${usedBytes}`, 'error');
    event.target.value = usedBytes;
    activeCommand.value.payloadLen = usedBytes;
    return;
  }
  activeCommand.value.payloadLen = clamped;
  event.target.value = clamped;
}

/**
 * 载荷模式切换：fixed <-> varlen
 */
function onPayloadModeChange(event) {
  if (!activeCommand.value) return;
  activeCommand.value.payloadMode = event.target.value;
}

/**
 * 命令码输入框数组：根据 CMD 字段配置的字节数动态调整长度
 * 当帧格式中 CMD 字节数变化时，自动填充或截断 cmdBytes
 */
const cmdByteInputs = computed({
  get() {
    const targetCount = getByteCount('cmd');
    if (!activeCommand.value) return [];
    const bytes = activeCommand.value.cmdBytes;
    /* 填充不足的字节 */
    while (bytes.length < targetCount) {
      bytes.push('00');
    }
    /* 截断超出的字节 */
    if (bytes.length > targetCount) {
      bytes.splice(targetCount);
    }
    /* 同步 cmd 字符串 */
    activeCommand.value.cmd = '0x' + bytes.join('');
    return bytes;
  },
  set() {
    /* setter 不需要操作，getter 中已处理同步 */
  },
});

function onDefaultByteInput(key, idx, event) {
  const val = event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2);
  const cfg = fieldConfig[key];
  while (cfg.defaults.length <= idx) cfg.defaults.push('00');
  cfg.defaults[idx] = val;
}

// 因为外容器不再用 <label> 包 checkbox，点击字段名时手动切勾选（恢复原本"点名称也能勾"的体验）
function toggleFieldEnabled(key) {
  const cfg = fieldConfig[key];
  if (cfg) cfg.enabled = !cfg.enabled;
}

/* ===================== 拖拽排序 ===================== */
let dragIdx = -1;
const dragOverIdx = ref(-1);

function onDragStart(idx, event) {
  // 三层兜底防止「在输入框中拖动选文字时误触发卡片拖拽」：
  // 1) 子控件自己有 @dragstart.prevent 拦截
  // 2) 这里检查 event.target 是否命中交互元素
  // 3) 当前 document.activeElement 如果是 input/select，证明正在交互，同样取消
  const target = event.target;
  const ae = document.activeElement;

  const isInteractiveEl = (el) => {
    if (!el || !(el instanceof Element)) return false;
    return !!el.closest(
      'input, select, button, textarea, ' +
      '.default-byte-boxes, .default-byte-box, .byte-count-select, .byte-count-custom'
    );
  };

  if (isInteractiveEl(target) || isInteractiveEl(ae)) {
    event.preventDefault();
    return;
  }
  dragIdx = idx;
}
function onDragOver(idx) {
  dragOverIdx.value = idx;
}
function onDragLeave(idx) {
  if (dragOverIdx.value === idx) dragOverIdx.value = -1;
}
function onDrop(idx) {
  if (dragIdx < 0 || dragIdx === idx) return;
  const item = fieldOrder.value.splice(dragIdx, 1)[0];
  fieldOrder.value.splice(idx, 0, item);
  dragIdx = -1;
  dragOverIdx.value = -1;
}
function onDragEnd() {
  dragIdx = -1;
  dragOverIdx.value = -1;
}

/* ===================== 帧格式预览 ===================== */
function checkTypeShort(type) {
  if (type.startsWith('CRC16')) return 'CRC16';
  if (type.startsWith('CRC32')) return 'CRC32';
  if (type.startsWith('CRC8')) return 'CRC8';
  if (type === 'Checksum') return 'SUM';
  if (type === 'XOR') return 'XOR';
  if (type === '无校验') return '—';
  return type;
}

const previewGroups = computed(() => {
  const groups = [];
  // 基于启用字段计算字节校验范围（abbr → 启用字段的索引）
  const opts = checkFieldOptions.value; // 已启用字段的 abbr 列表，顺序与 fieldOrder 对应
  const sIdx = opts.indexOf(checkStartField.value);
  const eIdx = opts.indexOf(checkEndField.value);
  const rangeStart = Math.min(sIdx, eIdx);
  const rangeEnd = Math.max(sIdx, eIdx);
  const inRange = (abbr) => {
    const i = opts.indexOf(abbr);
    return i >= 0 && i >= rangeStart && i <= rangeEnd;
  };
  for (const key of fieldOrder.value) {
    const cfg = fieldConfig[key];
    if (!cfg.enabled) continue;
    let cls = '';
    if (key === 'sof') cls = 'header';
    else if (key === 'eof') cls = 'tail';
    else if (key === 'chk') cls = 'check';
    else if (key === 'cmd') cls = 'cmd';
    else if (key === 'data') cls = 'data';

    let bytes = [];
    if (hasDefaults(key)) {
      const count = getByteCount(key);
      for (let i = 0; i < count; i++) bytes.push(cfg.defaults[i] || '00');
    } else if (key === 'chk') {
      bytes = [checkTypeShort(checkType.value)];
    } else if (key === 'len') {
      /* LEN 预览 = 当前命令的载荷字节数，按 LEN 字节数展开（小端低位在前） */
      const dataCount = getCmdPayloadLen(activeCommand.value);
      const lenN = getByteCount('len');
      const hexStr = dataCount.toString(16).toUpperCase().padStart(lenN * 2, '0');
      bytes = hexStr.match(/.{2}/g) || [];
      if (endianness.value.includes('小端')) bytes = bytes.slice().reverse();
    } else {
      /* DATA 预览 = 当前命令的载荷字节数 */
      const count = key === 'data' ? getCmdPayloadLen(activeCommand.value) : getByteCount(key);
      bytes = Array(count).fill('00');
    }
    groups.push({
      key,
      label: previewLabels[key],
      bytes,
      cls,
      inCheckRange: inRange(fieldDefs[key].abbr),
    });
  }
  return groups;
});

/**
 * 为指定命令构建完整帧报文示例（用于命令卡片悬浮提示）
 * 遍历 fieldOrder 中所有启用的字段，按帧格式配置生成 hex 字节
 */
function buildFrameExample(cmd) {
  const groups = [];
  const isLE = endianness.value.includes('小端');

  for (const key of fieldOrder.value) {
    const cfg = fieldConfig[key];
    if (!cfg.enabled) continue;

    const def = fieldDefs[key];
    const label = previewLabels[key];
    let bytes = [];

    if (key === 'cmd' && cmd) {
      /* 命令字：使用命令自身的 cmdBytes，按字段配置字节数对齐 */
      const n = getByteCount('cmd');
      bytes = Array.from({ length: n }, (_, i) =>
        (cmd.cmdBytes && cmd.cmdBytes[i]) ? cmd.cmdBytes[i] : '00',
      );
    } else if (hasDefaults(key)) {
      const n = getByteCount(key);
      bytes = Array.from({ length: n }, (_, i) => cfg.defaults[i] || '00');
    } else if (key === 'chk') {
      /* 校验位：占位，实际值取决于整帧内容 */
      const n = getByteCount('chk');
      bytes = Array(n).fill('XX');
    } else if (key === 'len') {
      /* LEN = 该命令的载荷字节数，按 LEN 字节数展开 */
      const dataCount = cmd ? getCmdPayloadLen(cmd) : getByteCount('data');
      const lenN = getByteCount('len');
      const hexStr = dataCount.toString(16).toUpperCase().padStart(lenN * 2, '0');
      bytes = hexStr.match(/.{2}/g) || [];
      if (isLE) bytes = bytes.slice().reverse();
    } else if (key === 'data') {
      /* DATA = 载荷字节数个 00 占位 */
      const count = cmd ? getCmdPayloadLen(cmd) : getByteCount('data');
      bytes = Array(count).fill('00');
    }

    groups.push({ key, abbr: def.abbr, label, bytes });
  }
  return groups;
}

/* ===================== 全局帧配置 ===================== */
const endianness = ref('小端 (Little-Endian)');
const checkType = ref('CRC16-MODBUS');
const checkStartField = ref('SOF');
const checkEndField = ref('DATA');
const checkFieldOptions = computed(() => fieldOrder.value.filter(k => !!fieldConfig[k]?.enabled).map(k => fieldDefs[k].abbr));

// 启用字段变化后，如果当前选择的校验起始/结束字节不再在列表里，自动回退到合法候选
watch(
  checkFieldOptions,
  (opts) => {
    if (!opts || !opts.length) return;
    const clamp = (cur, fallback) => {
      if (opts.includes(cur)) return cur;
      // 优先回退到 fallback；若 fallback 也不在，取列表第一个
      return opts.includes(fallback) ? fallback : opts[0];
    };
    checkStartField.value = clamp(checkStartField.value, 'SOF');
    // 结束字节默认尽量选最后一个（最常见：校验到数据尾）
    checkEndField.value = clamp(checkEndField.value, opts[opts.length - 1]);
  },
  { immediate: true }
);

const checkTypes = [
  'CRC16-MODBUS', 'CRC16-IBM', 'CRC16-MAXIM', 'CRC16-USB',
  'CRC16/CCITT', 'CRC16/CCITT-FALSE', 'CRC16/X25', 'CRC16/XMODEM', 'CRC16/DNP',
  'CRC32', 'CRC32/MPEG-2',
  'CRC8', 'CRC8/ITU', 'CRC8/ROHC', 'CRC8/MAXIM',
  'Checksum', 'XOR', '无校验',
];

/* ===================== 校验参数数据 ===================== */
function makeCRC16(type, model, poly, init, xorout, refin, refout) {
  const rIn = refin === '是' ? 'true' : 'false';
  const rOut = refout === '是' ? 'true' : 'false';
  return {
    type,
    rows: [
      ['模型', model],
      ['宽度', '16 bit'],
      ['多项式', poly],
      ['初始值', init],
      ['结果异或值', xorout],
      ['输入反转', refin],
      ['输出反转', refout],
    ],
    code:
`uint16_t crc16_update(uint16_t crc, uint8_t byte, uint16_t poly, bool refin) {
    if (refin) byte = reflect8(byte);
    crc ^= ((uint16_t)byte << 8);
    for (uint8_t bit = 0; bit < 8; bit++) {
        if (crc & 0x8000) crc = (crc << 1) ^ poly;
        else crc <<= 1;
    }
    return crc;
}

uint16_t crc16(const uint8_t *data, size_t start, size_t end,
               uint16_t poly, uint16_t init, bool refin, bool refout, uint16_t xorout) {
    uint16_t crc = init;
    for (size_t i = start; i <= end; i++)
        crc = crc16_update(crc, data[i], poly, refin);
    if (refout) crc = reflect16(crc);
    return crc ^ xorout;
}

uint16_t value = crc16(data, start, end, ${poly}, ${init}, ${rIn}, ${rOut}, ${xorout});
chk[0] = (value >> 8) & 0xFF;
chk[1] = value & 0xFF;`,
  };
}

function makeCRC32(type, model, poly, init, xorout, refin, refout) {
  const rIn = refin === '是' ? 'true' : 'false';
  const rOut = refout === '是' ? 'true' : 'false';
  return {
    type,
    rows: [
      ['模型', model],
      ['宽度', '32 bit'],
      ['多项式', poly],
      ['初始值', init],
      ['结果异或值', xorout],
      ['输入反转', refin],
      ['输出反转', refout],
    ],
    code:
`uint32_t crc32_update(uint32_t crc, uint8_t byte, uint32_t poly, bool refin) {
    if (refin) byte = reflect8(byte);
    crc ^= ((uint32_t)byte << 24);
    for (uint8_t bit = 0; bit < 8; bit++) {
        if (crc & 0x80000000) crc = (crc << 1) ^ poly;
        else crc <<= 1;
    }
    return crc;
}

uint32_t crc32(const uint8_t *data, size_t start, size_t end,
               uint32_t poly, uint32_t init, bool refin, bool refout, uint32_t xorout) {
    uint32_t crc = init;
    for (size_t i = start; i <= end; i++)
        crc = crc32_update(crc, data[i], poly, refin);
    if (refout) crc = reflect32(crc);
    return crc ^ xorout;
}

uint32_t value = crc32(data, start, end, ${poly}, ${init}, ${rIn}, ${rOut}, ${xorout});
chk[0] = (value >> 24) & 0xFF;
chk[1] = (value >> 16) & 0xFF;
chk[2] = (value >> 8) & 0xFF;
chk[3] = value & 0xFF;`,
  };
}

function makeCRC8(type, model, poly, init, xorout, refin, refout) {
  const rIn = refin === '是' ? 'true' : 'false';
  const rOut = refout === '是' ? 'true' : 'false';
  return {
    type,
    rows: [
      ['模型', model],
      ['宽度', '8 bit'],
      ['多项式', poly],
      ['初始值', init],
      ['结果异或值', xorout],
      ['输入反转', refin],
      ['输出反转', refout],
    ],
    code:
`uint8_t crc8_update(uint8_t crc, uint8_t byte, uint8_t poly, bool refin) {
    if (refin) byte = reflect8(byte);
    crc ^= byte;
    for (uint8_t bit = 0; bit < 8; bit++) {
        if (crc & 0x80) crc = (crc << 1) ^ poly;
        else crc <<= 1;
    }
    return crc;
}

uint8_t crc8(const uint8_t *data, size_t start, size_t end,
             uint8_t poly, uint8_t init, bool refin, bool refout, uint8_t xorout) {
    uint8_t crc = init;
    for (size_t i = start; i <= end; i++)
        crc = crc8_update(crc, data[i], poly, refin);
    if (refout) crc = reflect8(crc);
    return crc ^ xorout;
}

uint8_t value = crc8(data, start, end, ${poly}, ${init}, ${rIn}, ${rOut}, ${xorout});
chk[0] = value;`,
  };
}

const checkParamsList = [
  makeCRC16('CRC16-MODBUS',       'CRC-16/MODBUS',       '0x8005', '0xFFFF', '0x0000', '是', '是'),
  makeCRC16('CRC16-IBM',           'CRC-16/IBM',          '0x8005', '0x0000', '0x0000', '是', '是'),
  makeCRC16('CRC16-MAXIM',         'CRC-16/MAXIM',        '0x8005', '0x0000', '0xFFFF', '是', '是'),
  makeCRC16('CRC16-USB',           'CRC-16/USB',          '0x8005', '0xFFFF', '0xFFFF', '是', '是'),
  makeCRC16('CRC16/CCITT',         'CRC-16/CCITT',        '0x1021', '0x0000', '0x0000', '是', '是'),
  makeCRC16('CRC16/CCITT-FALSE',   'CRC-16/CCITT-FALSE',  '0x1021', '0xFFFF', '0x0000', '否', '否'),
  makeCRC16('CRC16/X25',           'CRC-16/X25',          '0x1021', '0xFFFF', '0xFFFF', '是', '是'),
  makeCRC16('CRC16/XMODEM',        'CRC-16/XMODEM',       '0x1021', '0x0000', '0x0000', '否', '否'),
  makeCRC16('CRC16/DNP',            'CRC-16/DNP',          '0x3D65', '0x0000', '0xFFFF', '是', '是'),
  makeCRC32('CRC32',                'CRC-32',              '0x04C11DB7', '0xFFFFFFFF', '0xFFFFFFFF', '是', '是'),
  makeCRC32('CRC32/MPEG-2',         'CRC-32/MPEG-2',       '0x04C11DB7', '0xFFFFFFFF', '0x00000000', '否', '否'),
  makeCRC8('CRC8',                  'CRC-8',               '0x07', '0x00', '0x00', '否', '否'),
  makeCRC8('CRC8/ITU',              'CRC-8/ITU',           '0x07', '0x00', '0x55', '否', '否'),
  makeCRC8('CRC8/ROHC',             'CRC-8/ROHC',          '0x07', '0xFF', '0x00', '是', '是'),
  makeCRC8('CRC8/MAXIM',            'CRC-8/MAXIM',         '0x31', '0x00', '0x00', '是', '是'),
  {
    type: 'Checksum',
    rows: [
      ['模型', '累加和校验'],
      ['初始值', '0x00'],
      ['结果取反', '否'],
      ['输出掩码', '0xFF'],
    ],
    code:
`uint8_t sum = 0x00;
for (size_t i = start; i <= end; i++)
    sum += data[i];
sum &= 0xFF;
chk[0] = sum;`,
  },
  {
    type: 'XOR',
    rows: [
      ['模型', '异或校验'],
      ['初始值', '0x00'],
      ['最终异或值', '0x00'],
    ],
    code:
`uint8_t xor_val = 0x00;
for (size_t i = start; i <= end; i++)
    xor_val ^= data[i];
chk[0] = xor_val;`,
  },
  {
    type: '无校验',
    rows: null,
    code: null,
    exampleTitle: '提示',
    note: '当前选择「无校验」，帧中不计算校验字段。',
  },
];

/* ===================== 模块地址配置 ===================== */
const selectedModuleIndex = ref(-1);
const moduleAddresses = ref([
  { name: '主控制器', addressBytes: ['01'] },
  { name: '传感器节点 A', addressBytes: ['10'] },
  { name: '传感器节点 B', addressBytes: ['11'] },
]);

/**
 * 模块地址字节数：与帧格式中 SRC 字段的字节数一致
 * SRC 和 DST 共用同一个地址空间，因此模块地址宽度 = SRC 字节数
 */
const moduleAddrByteCount = computed(() => {
  /* SRC 字段启用时使用其字节数，否则默认 1 字节 */
  if (fieldConfig.src && fieldConfig.src.enabled) {
    return getByteCount('src');
  }
  return 1;
});

/**
 * 同步所有模块地址的 addressBytes 长度到帧格式配置
 * 当 SRC 字节数变化时，自动填充或截断每个模块的地址字节
 */
watch(moduleAddrByteCount, (newCount) => {
  moduleAddresses.value.forEach(mod => {
    while (mod.addressBytes.length < newCount) {
      mod.addressBytes.push('00');
    }
    if (mod.addressBytes.length > newCount) {
      mod.addressBytes.splice(newCount);
    }
  });
}, { immediate: true });

function addModule() {
  const byteCount = moduleAddrByteCount.value;
  const maxAddr = moduleAddresses.value.reduce((max, m) => {
    const v = parseInt(m.addressBytes[0] || '0', 16);
    return v > max ? v : max;
  }, 0);
  const newAddr = (maxAddr + 1).toString(16).padStart(2, '0').toUpperCase();
  /* 按帧格式配置的字节数生成地址 */
  const addressBytes = Array.from({ length: byteCount }, (_, i) => i === 0 ? newAddr : '00');
  moduleAddresses.value.push({
    name: `模块 ${moduleAddresses.value.length + 1}`,
    addressBytes,
  });
  selectedModuleIndex.value = moduleAddresses.value.length - 1;
}

function deleteModule() {
  if (selectedModuleIndex.value < 0) return;
  moduleAddresses.value.splice(selectedModuleIndex.value, 1);
  selectedModuleIndex.value = -1;
}

function onAddressByteInput(mod, ai, event) {
  const val = event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2);
  mod.addressBytes[ai] = val;
}

/* ===================== 命令字配置 ===================== */
const commandFilter = ref('all');
const commandSearch = ref('');
const activeCommandIndex = ref(0);
const selectedFieldIndex = ref(-1);
const hoveredCmd = ref(null);
const tooltipPos = ref({ x: 0, y: 0, placed: false });

/* 悬浮命令的帧报文示例（缓存计算结果，避免模板中重复调用） */
const hoveredFrame = computed(() => {
  if (!hoveredCmd.value) return null;
  return buildFrameExample(hoveredCmd.value);
});

/* 悬浮窗定位样式：优先右侧，空间不足时下方 */
const tooltipStyle = computed(() => {
  if (!tooltipPos.value.placed) return { display: 'none' };
  return {
    left: tooltipPos.value.x + 'px',
    top: tooltipPos.value.y + 'px',
  };
});

/* 鼠标进入命令卡片：记录命令 + 计算悬浮窗位置 */
function onCmdHover(event, cmd) {
  hoveredCmd.value = cmd;
  const rect = event.currentTarget.getBoundingClientRect();
  const tooltipW = 360;
  const tooltipH = 200;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x = rect.right + gap;
  let y = rect.top;

  /* 右侧空间不足 → 放左侧 */
  if (x + tooltipW > vw - 8) {
    x = rect.left - tooltipW - gap;
  }
  /* 左侧也不够 → 放下方 */
  if (x < 8) {
    x = rect.left;
    y = rect.bottom + gap;
  }
  /* 下方溢出 → 上移 */
  if (y + tooltipH > vh - 8) {
    y = Math.max(8, vh - tooltipH - 8);
  }

  tooltipPos.value = { x, y, placed: true };
}

const commands = ref([
  {
    cmd: '0x01', cmdBytes: ['01'], name: '查询传感器数据',
    sender: '主控制器', receiver: '传感器节点 A', dir: 'tx', cycle: '500', payloadLen: 3,
    fields: [
      { name: '状态字', type: 'bitfield', bits: Array.from({ length: 8 }, (_, i) => ({ bit: i, zero: '', one: '' })) },
      { name: '错误码', type: 'enum', enumItems: [
        { value: '00', meaning: '正常' },
        { value: '01', meaning: '超时' },
        { value: '02', meaning: '校验错误' },
      ] },
      { name: '温度低字节', type: 'raw', rawValue: '00' },
    ],
  },
  {
    cmd: '0x81', cmdBytes: ['81'], name: '上报传感器数据',
    sender: '传感器节点 A', receiver: '主控制器', dir: 'rx', cycle: '0', payloadLen: 1,
    fields: [{ name: '温度', type: 'raw', rawValue: '00' }],
  },
  {
    cmd: '0x02', cmdBytes: ['02'], name: '设置采样周期',
    sender: '主控制器', receiver: '传感器节点 A', dir: 'tx', cycle: '300', payloadLen: 1,
    fields: [{ name: '周期', type: 'raw', rawValue: '64' }],
  },
  {
    cmd: '0x03', cmdBytes: ['03'], name: '复位设备',
    sender: '主控制器', receiver: '传感器节点 A', dir: 'tx', cycle: '1000', payloadLen: 0,
    fields: [],
  },
]);

const filteredCommandsWithIndex = computed(() => {
  let result = commands.value.map((cmd, originalIdx) => ({ cmd, originalIdx }));
  if (commandFilter.value !== 'all') {
    result = result.filter(({ cmd }) => cmd.dir === commandFilter.value);
  }
  if (commandSearch.value.trim()) {
    const s = commandSearch.value.toLowerCase();
    result = result.filter(({ cmd }) =>
      cmd.name.toLowerCase().includes(s) || cmd.cmd.toLowerCase().includes(s),
    );
  }
  return result;
});

const activeCommand = computed(() => {
  if (activeCommandIndex.value >= 0 && activeCommandIndex.value < commands.value.length) {
    return commands.value[activeCommandIndex.value];
  }
  return null;
});

function onCmdByteInput(ci, event) {
  if (!activeCommand.value) return;
  const val = event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2);
  activeCommand.value.cmdBytes[ci] = val;
  activeCommand.value.cmd = '0x' + activeCommand.value.cmdBytes.join('');
}

function addCommand() {
  const maxCmd = commands.value.reduce((max, c) => {
    const v = parseInt(c.cmd.replace('0x', ''), 16);
    return v > max ? v : max;
  }, 0);
  const newCmd = (maxCmd + 1).toString(16).padStart(2, '0').toUpperCase();
  /* 根据 CMD 字段配置的字节数生成 cmdBytes */
  const cmdCount = getByteCount('cmd');
  const cmdBytes = Array.from({ length: cmdCount }, (_, i) => i === cmdCount - 1 ? newCmd : '00');
  commands.value.push({
    cmd: `0x${cmdBytes.join('')}`, cmdBytes, name: '新命令',
    sender: '', receiver: '', dir: 'tx', cycle: '0', fields: [],
    payloadMode: 'fixed',
    payloadLen: getCmdPayloadLen(null),
  });
  activeCommandIndex.value = commands.value.length - 1;
}

function deleteCommand() {
  if (activeCommandIndex.value < 0) return;
  commands.value.splice(activeCommandIndex.value, 1);
  if (commands.value.length === 0) {
    activeCommandIndex.value = -1;
  } else if (activeCommandIndex.value >= commands.value.length) {
    activeCommandIndex.value = commands.value.length - 1;
  }
}

function addField() {
  if (!activeCommand.value) return;
  if (!isCmdVarlen(activeCommand.value)) {
    const max = getCmdPayloadLen(activeCommand.value);
    const used = getFieldBytesTotal(activeCommand.value.fields);
    if (used >= max) {
      showToast(`字段已占用 ${used} 字节，载荷上限 ${max} 字节，请先增大载荷字节数或切换为变长模式`, 'error');
      return;
    }
  }
  activeCommand.value.fields.push({
    name: '新字段', type: 'bitfield', length: 1,
    bits: Array.from({ length: 8 }, (_, i) => ({ bit: i, zero: '', one: '' })),
  });
}

function deleteField() {
  if (!activeCommand.value || selectedFieldIndex.value < 0) return;
  activeCommand.value.fields.splice(selectedFieldIndex.value, 1);
  selectedFieldIndex.value = -1;
}

/* ===================== 字段排序（拖拽 + 上移/下移） ===================== */

const dragFieldIndex = ref(-1);
const dragOverFieldIndex = ref(-1);

function onFieldDragStart(fi, event) {
  // 第二处表格：仅从第一列「拖拽把手」(field-drag-handle) 发起才算有效，
  // 点到字段名 input / 类型 select / 配置区 的字节输入框/checkbox/下拉框 一律取消拖拽
  const target = event.target;
  if (!target || !(target instanceof Element)) { event.preventDefault(); return; }
  const fromHandle = target.closest('.field-drag-col, .field-drag-handle');
  if (!fromHandle) {
    event.preventDefault();
    return;
  }
  dragFieldIndex.value = fi;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(fi));
}

function onFieldDragOver(fi) {
  if (dragFieldIndex.value < 0 || dragFieldIndex.value === fi) return;
  dragOverFieldIndex.value = fi;
}

function onFieldDragLeave() {
  dragOverFieldIndex.value = -1;
}

function onFieldDrop(fi) {
  const from = dragFieldIndex.value;
  if (from >= 0 && from !== fi && activeCommand.value) {
    const fields = activeCommand.value.fields;
    const [moved] = fields.splice(from, 1);
    fields.splice(fi, 0, moved);
    selectedFieldIndex.value = fi;
  }
  onFieldDragEnd();
}

function onFieldDragEnd() {
  dragFieldIndex.value = -1;
  dragOverFieldIndex.value = -1;
}

function moveField(fi, dir) {
  if (!activeCommand.value) return;
  const fields = activeCommand.value.fields;
  const target = fi + dir;
  if (target < 0 || target >= fields.length) return;
  const [moved] = fields.splice(fi, 1);
  fields.splice(target, 0, moved);
  selectedFieldIndex.value = target;
}

function onFieldTypeChange(field) {
  if (field.type === 'bitfield') {
    if (!field.bits) field.bits = Array.from({ length: 8 }, (_, i) => ({ bit: i, zero: '', one: '' }));
    field.length = 1;
    delete field.lengthMode;
  } else if (field.type === 'enum') {
    if (!field.enumItems) field.enumItems = [{ value: '00', meaning: '' }];
    field.length = 1;
    delete field.lengthMode;
  } else if (field.type === 'raw') {
    if (field.rawValue === undefined) field.rawValue = '00';
    field.length = 1;
    delete field.lengthMode;
  } else if (field.type === 'number') {
    if (!field.length) field.length = 2;
    if (!field.encoding) field.encoding = 'uint16';
    if (field.scale === undefined) field.scale = 1;
    if (field.unit === undefined) field.unit = '';
    delete field.lengthMode;
  } else if (field.type === 'text') {
    if (!field.lengthMode) field.lengthMode = 'varlen-field';
    if (!field.encoding) field.encoding = 'utf8';
    if (!field.format) field.format = 'raw';
    if (!field.lengthField) field.lengthField = 'len';
    delete field.length;
  } else if (field.type === 'binary') {
    if (!field.lengthMode) field.lengthMode = 'varlen-rest';
    if (!field.encoding) field.encoding = 'hex';
    delete field.length;
  }
}

/**
 * 获取单个字段的固定字节数（变长字段返回 0，运行时确定）
 */
function getFieldByteCount(field) {
  if (field.lengthMode && field.lengthMode !== 'fixed') return 0;
  if (field.length && Number.isFinite(+field.length) && +field.length > 0) return Math.floor(+field.length);
  return 1;
}

/**
 * 获取所有固定字段占用的总字节数（变长字段不计入）
 */
function getFieldBytesTotal(fields) {
  if (!fields) return 0;
  return fields.reduce((sum, f) => sum + getFieldByteCount(f), 0);
}

/**
 * 判断命令是否为变长模式
 */
function isCmdVarlen(cmd) {
  return cmd && cmd.payloadMode === 'varlen';
}

/**
 * 数字编码切换时自动更新字节数
 */
function onNumberEncodingChange(field) {
  const map = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 };
  field.length = map[field.encoding] || 1;
}

function addEnumItem(field) {
  const next = field.enumItems.length.toString(16).toUpperCase().padStart(2, '0');
  field.enumItems.push({ value: next, meaning: '' });
}

function onEnumValueInput(field, ei, event) {
  const val = event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2);
  field.enumItems[ei].value = val;
}

function onRawValueInput(field, event) {
  const val = event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2);
  field.rawValue = val;
}

/* ===================== 新建协议 / 保存配置 / 选择 / 删除 ===================== */

const saveStatus = ref('保存配置');
function updateSaveStatusText() {
  saveStatus.value = isRemoteMode.value ? '保存草稿' : '保存配置';
}

/**
 * 选择协议：若当前协议有未保存变更，弹出确认弹窗；否则直接切换
 * @param {object} proto - 协议列表项
 */
function selectProtocol(proto) {
  if (proto.name === activeProtocol.value) return;

  /* 检查未保存变更 */
  if (hasUnsavedChanges.value && !dontAskAgain.value) {
    unsavedDialog.fromName = activeProtocol.value;
    unsavedDialog.toName = proto.name;
    unsavedDialog.pendingProto = proto;
    unsavedDialog.show = true;
    return;
  }

  doSwitchProtocol(proto);
}

/**
 * 实际执行协议切换逻辑
 * @param {object} proto - 协议列表项
 */
function doSwitchProtocol(proto) {
  /* 保存当前编辑器状态到当前激活的协议 */
  const idx = protocolList.value.findIndex(p => p.name === activeProtocol.value);
  if (idx !== -1) {
    protocolList.value[idx] = {
      ...protocolList.value[idx],
      config: captureEditorState(),
    };
  }

  /* 加载目标协议配置 */
  activeProtocol.value = proto.name;
  const target = protocolList.value.find(p => p.name === proto.name);
  if (target && target.config) {
    restoreEditorState(target.config);
  }
  /* 同步乐观锁标记与已保存快照
   * dbId 为数据库真实行 id（仅 DB 加载的协议有）；内存协议（默认项/草稿）无 dbId → null，
   * 保存时走按名称清理路径，不参与 CAS，避免把内存假 uid 当行 id 误报冲突 */
  editorLoadedProtoId.value = target ? (target.dbId ?? null) : null;
  savedSnapshot.value = captureEditorState();
}

/**
 * 弹窗：不保存，直接切换
 */
function unsavedCancel() {
  const proto = unsavedDialog.pendingProto;
  unsavedDialog.show = false;
  if (proto) {
    /* 放弃当前编辑器变更，直接切换 */
    savedSnapshot.value = null;
    doSwitchProtocol(proto);
  }
}

/**
 * 弹窗：保存并切换
 */
async function unsavedSaveAndSwitch() {
  const proto = unsavedDialog.pendingProto;
  unsavedDialog.show = false;
  if (proto) {
    await saveConfig();
    doSwitchProtocol(proto);
  }
}

/**
 * 删除协议：从列表移除，并从数据库删除（若 Electron 环境）
 * 单事务先清子表再删主表（外键级联未启用，显式清理避免孤儿数据）
 * 注意：protocol_versions 版本快照有意保留，便于同名协议重建后追溯历史
 * 若删除的是当前选中的协议，自动切换到列表中的第一个
 * @param {object} proto - 协议列表项
 */
async function deleteProtocol(proto) {
  /* 从数据库删除 */
  if (hasElectron) {
    try {
      if (isRemoteMode.value && proto.draft && window.electronAPI.draft) {
        /* 远程模式 + 草稿：只删除本地草稿，不动服务器 */
        await window.electronAPI.draft.delete(proto.name);
      } else {
        /* 本地模式 / 服务器正式版：正常删除 */
        await window.electronAPI.db.batch([
          { sql: 'DELETE FROM commands WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [proto.name] },
          { sql: 'DELETE FROM modules WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [proto.name] },
          { sql: 'DELETE FROM protocols WHERE name = ?', params: [proto.name] },
        ]);
      }
    } catch (err) {
      /* 数据库删除失败不影响内存列表的清理 */
    }
  }

  /* 从内存列表移除 */
  const idx = protocolList.value.findIndex(p => p.name === proto.name);
  if (idx < 0) return;
  protocolList.value.splice(idx, 1);

  /* 若删除的是当前选中的协议，切换到列表第一项 */
  if (activeProtocol.value === proto.name) {
    if (protocolList.value.length > 0) {
      const next = protocolList.value[0];
      activeProtocol.value = next.name;
      if (next.config) {
        restoreEditorState(next.config);
      }
      editorLoadedProtoId.value = next.dbId ?? null;
      /* 同步保存快照：否则 hasUnsavedChanges 误判为 true，
       * 后续新建协议会被"当前协议有未保存的变更"拦截（与 doSwitchProtocol 对齐） */
      savedSnapshot.value = captureEditorState();
    } else {
      /* 列表为空时直接重置编辑器并添加一个新协议，不调用 newProtocol 避免保存已删除协议的状态 */
      const newName = '新协议';
      restoreEditorState(defaultEditorState(newName));
      editorLoadedProtoId.value = null;
      const newProto = {
        name: newName,
        status: '草稿',
        draft: true,
        version: 'v1.0.0',
        reviewStatus: null,
        config: captureEditorState(),
      };
      protocolList.value.push(newProto);
      activeProtocol.value = newName;
      /* 新协议的初始状态作为已保存基线 */
      savedSnapshot.value = captureEditorState();
    }
  }
}

/* ===================== 提交审核 ===================== */

/**
 * 审核状态文本映射
 * @param {string} status - 'pending' | 'approved' | 'rejected' | 'published' | 'withdrawn' | null
 * @returns {string} 显示文本
 */
function reviewStatusText(status) {
  return { pending: '审核中', approved: '已通过', rejected: '已驳回', published: '已生效', withdrawn: '已撤回' }[status] || '';
}

/* ===================== 审核人选人弹窗 ===================== */
const reviewerDialog = reactive({
  show: false,
  proto: null,
  selectedUser: null,
  candidates: [],
});

/**
 * 打开审核人选择弹窗
 * @param {object} proto - 协议列表项
 */
async function submitForReview(proto) {
  if (proto.reviewStatus === 'approved' || proto.reviewStatus === 'published') {
    showToast('该协议已审核通过，无需再次审核', 'success');
    return;
  }
  if (proto.reviewStatus === 'pending') {
    showToast('该协议正在审核中，请耐心等待', 'success');
    return;
  }
  /* 每次打开弹窗都从数据库刷新，确保新创建的用户出现在列表中 */
  await loadKnownUsers();
  reviewerDialog.candidates = getReviewCandidates();
  reviewerDialog.proto = proto;
  reviewerDialog.selectedUser = null;
  reviewerDialog.show = true;
}

/**
 * 确认提交审核：保存当前协议快照到 protocol_versions，
 * 对比上一版快照生成真实 diff，写入审核队列
 */
async function confirmSubmitReview() {
  if (!reviewerDialog.selectedUser || !reviewerDialog.proto) return;

  const proto = reviewerDialog.proto;
  const displayName = proto.name;
  const assignee = reviewerDialog.selectedUser.name;

  try {
    /* 1. 捕获新快照。只有提交的就是当前编辑中的协议时，编辑器状态才是它的内容；
     * 提交列表里其他协议时编辑器里装的是别的协议，必须取该协议自身的已保存配置，
     * 否则快照与基线对比整个串到别的协议（通过后发布还会把别的协议内容写进本协议） */
    const isProtoActive = proto.name === activeProtocol.value;
    if (!isProtoActive && !proto.config) {
      showToast('该协议的配置内容尚未加载，请先在列表中点击选中后再提交审核', 'error');
      return;
    }
    const newSnap = isProtoActive
      ? captureEditorState()
      : JSON.parse(JSON.stringify(proto.config));
    if (!isProtoActive) newSnap.protoName = displayName;
    newSnap.name = displayName;
    const newSnapJson = JSON.stringify(newSnap);
    const versionStr = 'v' + newSnap.versionMajor + '.' + newSnap.versionMinor + '.' + newSnap.versionPatch;

    /* 2. 用 protocol_id 查找基线版本（current_version_id 指向的 published 版本） */
    var oldSnap = null;
    var baseVersionId = null;
    if (window.electronAPI?.db) {
      /* 2a. 查 protocols.id 和 current_version_id */
      var protoRes = await window.electronAPI.db.query(
        'SELECT id, current_version_id FROM protocols WHERE name = ? ORDER BY id DESC LIMIT 1',
        [displayName],
      );
      if (protoRes.success && protoRes.rows && protoRes.rows.length) {
        var protoId = protoRes.rows[0].id;
        var curVerId = protoRes.rows[0].current_version_id;

        /* 2b. 如果有 current_version_id，直接查该版本的快照 */
        if (curVerId) {
          baseVersionId = curVerId;
          var verRes = await window.electronAPI.db.query(
            'SELECT config_json FROM protocol_versions WHERE id = ?',
            [curVerId],
          );
          if (verRes.success && verRes.rows && verRes.rows.length) {
            try { oldSnap = JSON.parse(verRes.rows[0].config_json); } catch { oldSnap = null; }
          }
        }

        /* 2c. current_version_id 查不到（可能旧数据断裂），按 protocol_id 查（published 优先，避免拿 draft 当基线） */
        if (!oldSnap) {
          var byPidRes = await window.electronAPI.db.query(
            'SELECT id, config_json FROM protocol_versions WHERE protocol_id = ? ORDER BY CASE WHEN status = ? THEN 0 ELSE 1 END, id DESC LIMIT 5',
            [protoId, 'published'],
          );
          if (byPidRes.success && byPidRes.rows) {
            for (var pi = 0; pi < byPidRes.rows.length; pi++) {
              if (byPidRes.rows[pi].config_json && byPidRes.rows[pi].config_json !== newSnapJson) {
                baseVersionId = byPidRes.rows[pi].id;
                try { oldSnap = JSON.parse(byPidRes.rows[pi].config_json); } catch { oldSnap = null; }
                if (oldSnap) break;
              }
            }
          }
        }
      }

      /* 2d. 以上都查不到（旧数据 protocol_id 为 NULL 或改名断裂），按 protocol_name 查 */
      if (!oldSnap) {
        var byNameRes = await window.electronAPI.db.query(
          'SELECT id, config_json FROM protocol_versions WHERE protocol_name = ? ORDER BY id DESC LIMIT 5',
          [displayName],
        );
        if (byNameRes.success && byNameRes.rows) {
          for (var ni = 0; ni < byNameRes.rows.length; ni++) {
            if (byNameRes.rows[ni].config_json && byNameRes.rows[ni].config_json !== newSnapJson) {
              baseVersionId = byNameRes.rows[ni].id;
              try { oldSnap = JSON.parse(byNameRes.rows[ni].config_json); } catch { oldSnap = null; }
              if (oldSnap) break;
            }
          }
        }
      }

      /* 2e. 不按 activeProtocol 兜底查历史版本/审核快照：该条件只在"提交的不是
       * 当前编辑中的协议"时才成立（提交当前协议时 activeProtocol 与 displayName 相同），
       * 查到的是别的协议的版本，正是"审核详情对比的是另一个协议"的缺陷来源。
       * 改名场景无需此兜底——saveConfig 的事务内已把版本行迁移到新名称。 */

      /* 2f. 兜底：查 audit_logs 里的提交快照 */
      if (!oldSnap) {
        var auditRes = await window.electronAPI.db.query(
          'SELECT snapshot_json FROM audit_logs WHERE protocol_name = ? AND snapshot_json != \'\' ORDER BY id DESC LIMIT 5',
          [displayName],
        );
        if (auditRes.success && auditRes.rows) {
          for (var ai = 0; ai < auditRes.rows.length; ai++) {
            if (auditRes.rows[ai].snapshot_json && auditRes.rows[ai].snapshot_json !== newSnapJson) {
              try { oldSnap = JSON.parse(auditRes.rows[ai].snapshot_json); } catch { oldSnap = null; }
              if (oldSnap) break;
            }
          }
        }
      }

    }

    /* 3. 生成真实 diff：旧快照 vs 新快照 */
    var diff = oldSnap
      ? generateProtocolDiff(oldSnap, newSnap)
      : { summary: { added: 0, deleted: 0, modified: 0, unchanged: 0, items: [{ type: 'add', text: '首次提交，无历史版本' }] }, oldVersion: { name: '—', version: '—', signalCount: 0, addressCount: 0 }, newVersion: { name: displayName, version: versionStr, signalCount: (newSnap.commands || []).length, addressCount: (newSnap.moduleAddresses || []).length }, metaChanges: [], commandRows: (newSnap.commands || []).map(function(c) { return { status: 'added', old: null, new: { cmd: c.cmd, name: c.name || '未命名', sender: c.sender || '—', receiver: c.receiver || '—', dir: c.dir || '—', cycle: c.cycle || '0', payloadLen: c.payloadLen || 0, fieldCount: (c.fields || []).length, fieldNames: [] } }; }) };

    /* 4. 提交审核（快照 + base_version_id 存入审核记录） */
    var changeId = await submitReview({
      name: displayName,
      type: '协议变更',
      applicant: currentUser.value?.username || currentUser.value?.name || '当前用户',
      assignee: assignee,
      scope: '协议配置',
      diff: diff,
      snapshot: newSnapJson,
      version: versionStr,
      baseVersionId: baseVersionId,
    });

    proto.reviewStatus = 'pending';
    proto.changeId = changeId;
    proto.draftDirty = false;
    reviewerDialog.show = false;
    reviewerDialog.selectedUser = null;
    showToast(`协议「${proto.name}」已提交审核，指定审核人：${assignee}`, 'success');
  } catch {
    showToast('提交审核失败，请重试', 'error');
  }
}

/**
 * 取消提交审核
 */
function cancelSubmitReview() {
  reviewerDialog.show = false;
  reviewerDialog.selectedUser = null;
  reviewerDialog.proto = null;
}

/* ===================== 发布生效 ===================== */

/**
 * 发布生效：将已审核通过的协议发布为最终状态
 * @param {object} proto - 协议列表项
 */
async function publishProtocol(proto) {
  if (proto.reviewStatus !== 'approved') return;
  if (!proto.changeId) {
    showToast('无法发布：缺少变更单号，请重新提交审核', 'error');
    return;
  }
  const wasDirty = !!proto.draftDirty;
  try {
    /* 发布以"审核通过的快照"为准（publishReview 内部单事务落地正式协议内容），
     * 不再直接推送本地草稿：草稿可能在通过后又被改动，直接推送会绕过审核 */
    await publishReview(proto.changeId);
    proto.reviewStatus = 'published';
    proto.status = '已启用';
    proto.draftDirty = false;
    if (isRemoteMode.value && window.electronAPI.draft) {
      /* 快照已生效，本地草稿完成使命；审核通过后又改过的草稿保留，走重新提审 */
      if (!wasDirty) {
        await window.electronAPI.draft.delete(proto.name).catch(() => { /* 非关键路径 */ });
      }
      proto.draft = false; /* 发布后不再是草稿 */
    }
    showToast(`协议「${proto.name}」已发布生效`, 'success');
  } catch {
    showToast('发布生效失败，请重试', 'error');
  }
}

/**
 * 新建协议：添加到列表但不自动选中，保持当前编辑状态不变
 * 若已存在未保存的"新协议"，阻止新建并提示
 */
function newProtocol() {
  if (hasUnsavedChanges.value) {
    showToast('当前协议有未保存的变更，请先保存再新建', 'error');
    return;
  }

  const existingDraft = protocolList.value.find(
    p => p.draft && p.status === '草稿' && p.name.startsWith('新协议'),
  );
  if (existingDraft) {
    showToast('请先保存或编辑当前的"新协议"再创建', 'error');
    return;
  }

  let newName = '新协议';
  let counter = 2;
  while (protocolList.value.some(p => p.name === newName)) {
    newName = `新协议${counter++}`;
  }

  protocolList.value.unshift({
    uid: Date.now(),
    name: newName,
    status: '草稿',
    draft: true,
    version: 'v1.0.0',
    reviewStatus: null,
    config: defaultEditorState(newName),
  });

  const curIdx = protocolList.value.findIndex(p => p.name === activeProtocol.value);
  if (curIdx !== -1) {
    protocolList.value[curIdx] = {
      ...protocolList.value[curIdx],
      config: captureEditorState(),
    };
  }

  activeProtocol.value = newName;
  restoreEditorState(defaultEditorState(newName));
  editorLoadedProtoId.value = null;
  savedSnapshot.value = captureEditorState();

  showToast(`协议「${newName}」已创建`, 'success');
}

/* ===================== 保存冲突（乐观锁） ===================== */
const conflictDialog = reactive({ show: false });

/**
 * 冲突后加载最新版本：重新拉取数据库列表并恢复当前协议的最新配置
 */
async function conflictReloadLatest() {
  const name = activeProtocol.value;
  conflictDialog.show = false;
  await loadProtocolsFromDB();
  const latest = protocolList.value.find(p => p.name === name);
  if (latest) {
    activeProtocol.value = name;
    restoreEditorState(latest.config);
    editorLoadedProtoId.value = latest.dbId ?? null;
    savedSnapshot.value = captureEditorState();
  }
  showToast('已加载最新版本，本地未保存的修改已丢弃', 'success');
}

/* ===================== 历史版本 ===================== */
const historyDialog = reactive({
  show: false,
  loading: false,
  versions: [],
});

/**
 * 打开历史版本弹窗：加载当前协议的全部版本快照（最新在前）
 */
async function openHistoryDialog() {
  historyDialog.versions = [];
  historyDialog.show = true;

  if (!hasElectron) return;
  historyDialog.loading = true;
  try {
    const res = await window.electronAPI.db.query(
      'SELECT id, version, config_json, created_by, created_at FROM protocol_versions WHERE protocol_name = ? ORDER BY id DESC',
      [activeProtocol.value],
    );
    if (res.success && res.rows) {
      historyDialog.versions = res.rows;
    }
  } catch (e) {
    showToast('历史版本加载失败', 'error');
  } finally {
    historyDialog.loading = false;
  }
}

/**
 * 载入历史版本到编辑器（回滚）
 * 不更新 savedSnapshot：载入后处于"未保存"状态，用户保存后才写回数据库
 */
function loadVersion(v) {
  try {
    const config = JSON.parse(v.config_json);
    restoreEditorState(config);
    /* 历史版本载入属于有意覆盖，不参与乐观锁比对 */
    editorLoadedProtoId.value = null;
    historyDialog.show = false;
    showToast(`已载入 ${v.version} 配置，保存后生效`, 'success');
  } catch (e) {
    showToast('版本快照解析失败', 'error');
  }
}

/* ===================== 协议导出 ===================== */
const exportDialog = reactive({ show: false });
const exportFormat = ref('json');
const exporting = ref(false);

const exportFormats = [
  { id: 'json', ext: 'JSON', name: 'JSON', desc: '结构化数据，可用于备份与迁移' },
  { id: 'md', ext: 'MD', name: 'Markdown', desc: '轻量文档，含完整信号定义表格' },
  { id: 'pdf', ext: 'PDF', name: 'PDF', desc: '打印友好的正式协议文档' },
];

/**
 * 文件名非法字符清理（Windows 保留字符替换为下划线）
 */
function sanitizeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

/**
 * 导出文件名: 协议名称_模块名称_版本号_YYYY-MM-DD
 * 随编辑器实时数据（协议名/模块/版本）同步更新
 */
const exportBaseName = computed(() => {
  const mod = moduleAddresses.value[selectedModuleIndex.value] || moduleAddresses.value[0];
  const modName = sanitizeFileName(mod ? mod.name : '通用模块');
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${sanitizeFileName(protoName.value)}_${modName}_${currentVersion.value}_${ymd}`;
});

/**
 * 打开导出弹窗
 */
function exportProtocol() {
  exportFormat.value = 'json';
  exportDialog.show = true;
}

/**
 * 导入协议：选择 JSON 文件 → 校验 → 以草稿形式加入协议列表并载入编辑器
 * 与 newProtocol 一致：仅进入编辑器，需手动点保存才写入数据库
 */
async function importProtocol() {
  if (hasUnsavedChanges.value) {
    showToast('当前协议有未保存的变更，请先保存再导入', 'error');
    return;
  }

  /* 选择并读取文件 */
  let content = null;
  if (hasElectron) {
    const res = await window.electronAPI.import.openFile();
    if (!res.success) {
      if (!res.canceled) showToast(`读取文件失败: ${res.error}`, 'error');
      return;
    }
    content = res.content;
  } else {
    /* 浏览器环境回退：动态 input[type=file] */
    content = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsText(file, 'utf-8');
      };
      input.click();
    });
    if (content == null) {
      showToast('读取文件失败', 'error');
      return;
    }
  }

  /* 解析 + 结构校验（导出格式：{ protocolName, version, description, exportedAt, config }） */
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    showToast('文件不是有效的 JSON', 'error');
    return;
  }
  const config = data && data.config;
  if (!config || typeof config.protoName !== 'string' || !config.protoName.trim()
    || !Array.isArray(config.fieldOrder) || !Array.isArray(config.commands)) {
    showToast('文件格式不正确：缺少协议配置（config）或必要字段', 'error');
    return;
  }

  /* 协议名唯一约束：重名时自动加 (n) 后缀 */
  let name = config.protoName.trim();
  config.protoName = name;
  if (protocolList.value.some((p) => p.name === name)) {
    let i = 2;
    while (protocolList.value.some((p) => p.name === `${name}(${i})`)) i++;
    name = `${name}(${i})`;
    config.protoName = name;
  }

  /* 存回当前编辑器状态 → 列表头部插入导入协议 → 载入编辑器 */
  const curIdx = protocolList.value.findIndex((p) => p.name === activeProtocol.value);
  if (curIdx !== -1) {
    protocolList.value[curIdx] = {
      ...protocolList.value[curIdx],
      config: captureEditorState(),
    };
  }
  protocolList.value.unshift({
    uid: Date.now(),
    name,
    status: '草稿',
    draft: true,
    version: `v${config.versionMajor || 1}.${config.versionMinor || 0}.${config.versionPatch || 0}`,
    reviewStatus: null,
    config,
  });
  activeProtocol.value = name;
  restoreEditorState(config);
  editorLoadedProtoId.value = null;
  savedSnapshot.value = captureEditorState();

  showToast(`协议「${name}」已导入，保存后写入数据库`, 'success');
}

/**
 * 构建 JSON 导出数据
 */
function buildExportData(state) {
  return {
    protocolName: state.protoName,
    version: `v${state.versionMajor}.${state.versionMinor}.${state.versionPatch}`,
    description: state.protoDesc,
    exportedAt: new Date().toISOString(),
    config: state,
  };
}

/**
 * 字段类型中文标签
 */
function fieldTypeLabel(type) {
  if (type === 'bitfield') return '位域';
  if (type === 'enum') return '枚举';
  return '原始值';
}

/**
 * 启用的帧字段列表（按 fieldOrder 顺序）
 */
function enabledFrameFields(state) {
  return state.fieldOrder
    .map(key => ({ key, def: fieldDefs[key], cfg: state.fieldConfig[key] }))
    .filter(f => f.def && f.cfg && f.cfg.enabled);
}

/* ===================== 导出：变更历史 ===================== */

/**
 * 对比新旧快照，生成结构化变更详情
 * @param {object} oldSnap - 旧快照
 * @param {object} newSnap - 新快照
 * @returns {object} { oldVersion, newVersion, summary, metaChanges, commandRows }
 */
function generateProtocolDiff(oldSnap, newSnap) {
  var metaChanges = [];
  var summaryItems = [];

  var oldName = oldSnap.protoName || oldSnap.name || '—';
  var newName = newSnap.protoName || newSnap.name || '—';
  if (oldName !== newName) {
    metaChanges.push({ field: '协议名称', old: oldName, new: newName });
    summaryItems.push({ type: 'modify', text: '协议名称: ' + oldName + ' → ' + newName });
  }

  var oldV = 'v' + (oldSnap.versionMajor || 0) + '.' + (oldSnap.versionMinor || 0) + '.' + (oldSnap.versionPatch || 0);
  var newV = 'v' + (newSnap.versionMajor || 0) + '.' + (newSnap.versionMinor || 0) + '.' + (newSnap.versionPatch || 0);
  if (oldV !== newV) {
    metaChanges.push({ field: '版本号', old: oldV, new: newV });
    summaryItems.push({ type: 'modify', text: '版本: ' + oldV + ' → ' + newV });
  }

  if ((oldSnap.protoDesc || '') !== (newSnap.protoDesc || ''))
    metaChanges.push({ field: '协议描述', old: oldSnap.protoDesc || '空', new: newSnap.protoDesc || '空' });

  if ((oldSnap.endianness || '') !== (newSnap.endianness || ''))
    metaChanges.push({ field: '字节序', old: oldSnap.endianness || '—', new: newSnap.endianness || '—' });

  if ((oldSnap.checkType || '') !== (newSnap.checkType || ''))
    metaChanges.push({ field: '校验方式', old: oldSnap.checkType || '—', new: newSnap.checkType || '—' });

  var oldMods = oldSnap.moduleAddresses || [];
  var newMods = newSnap.moduleAddresses || [];
  var oldModMap = {};
  var newModMap = {};
  oldMods.forEach(function (m) { oldModMap[m.name] = m; });
  newMods.forEach(function (m) { newModMap[m.name] = m; });
  newMods.forEach(function (m) {
    if (!oldModMap[m.name]) {
      metaChanges.push({ field: '模块: ' + m.name, old: '无', new: '地址: ' + (m.address || m.addr || '—') });
      summaryItems.push({ type: 'add', text: '新增模块: ' + m.name });
    }
  });
  oldMods.forEach(function (m) {
    if (!newModMap[m.name]) {
      metaChanges.push({ field: '模块: ' + m.name, old: '地址: ' + (m.address || m.addr || '—'), new: '已删除' });
      summaryItems.push({ type: 'delete', text: '删除模块: ' + m.name });
    }
  });
  newMods.forEach(function (m) {
    var om = oldModMap[m.name];
    if (om && (om.address || om.addr) !== (m.address || m.addr))
      metaChanges.push({ field: '模块: ' + m.name, old: '地址: ' + (om.address || om.addr || '—'), new: '地址: ' + (m.address || m.addr || '—') });
  });

  var oldCmds = oldSnap.commands || [];
  var newCmds = newSnap.commands || [];

  function cmdKey(c) {
    var n = typeof c.cmd === 'number' ? c.cmd : parseInt(c.cmd, 16);
    if (isNaN(n)) n = 0;
    return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
  }

  function cmdInfo(c) {
    if (!c) return null;
    return {
      cmd: cmdKey(c),
      name: c.name || '未命名',
      sender: c.sender || '—',
      receiver: c.receiver || '—',
      dir: c.dir === 'tx' ? '发送' : (c.dir === 'rx' ? '接收' : '—'),
      cycle: c.cycle || '0',
      payloadLen: c.payloadLen || 0,
      fieldCount: (c.fields || []).length,
      fieldNames: (c.fields || []).map(function (f) { return f.name || ''; }),
    };
  }

  var oldCmdMap = {};
  var newCmdMap = {};
  oldCmds.forEach(function (c) { oldCmdMap[cmdKey(c)] = c; });
  newCmds.forEach(function (c) { newCmdMap[cmdKey(c)] = c; });

  var added = 0, deleted = 0, modified = 0, unchanged = 0;
  var commandRows = [];

  oldCmds.forEach(function (oc) {
    var key = cmdKey(oc);
    if (!newCmdMap[key]) {
      deleted++;
      commandRows.push({ status: 'deleted', old: cmdInfo(oc), new: null });
      summaryItems.push({ type: 'delete', text: '删除 ' + key + ' ' + (oc.name || '') });
    }
  });

  newCmds.forEach(function (nc) {
    var key = cmdKey(nc);
    var oc = oldCmdMap[key];
    if (!oc) {
      added++;
      commandRows.push({ status: 'added', old: null, new: cmdInfo(nc) });
      summaryItems.push({ type: 'add', text: '新增 ' + key + ' ' + (nc.name || '') });
    } else if (JSON.stringify(oc) !== JSON.stringify(nc)) {
      modified++;
      var parts = [];
      if ((oc.name || '') !== (nc.name || '')) parts.push('名称: ' + (oc.name || '') + '→' + (nc.name || ''));
      if ((oc.payloadLen || 0) !== (nc.payloadLen || 0)) parts.push('数据长度: ' + (oc.payloadLen || 0) + 'B→' + (nc.payloadLen || 0) + 'B');
      if ((oc.sender || '') !== (nc.sender || '')) parts.push('发送方: ' + (oc.sender || '') + '→' + (nc.sender || ''));
      if ((oc.receiver || '') !== (nc.receiver || '')) parts.push('接收方: ' + (oc.receiver || '') + '→' + (nc.receiver || ''));
      if ((oc.cycle || '') !== (nc.cycle || '')) parts.push('周期: ' + (oc.cycle || '0') + '→' + (nc.cycle || '0') + 'ms');
      if ((oc.fields || []).length !== (nc.fields || []).length) parts.push('字段数: ' + (oc.fields || []).length + '→' + (nc.fields || []).length);
      var changeText = parts.length ? parts.join(', ') : '内容变更';
      commandRows.push({ status: 'modified', old: cmdInfo(oc), new: cmdInfo(nc) });
      summaryItems.push({ type: 'modify', text: key + ' ' + (nc.name || oc.name || '') + ': ' + changeText });
    } else {
      unchanged++;
      commandRows.push({ status: 'unchanged', old: cmdInfo(oc), new: cmdInfo(nc) });
    }
  });

  return {
    oldVersion: { name: oldName, version: oldV, signalCount: oldCmds.length, addressCount: oldMods.length },
    newVersion: { name: newName, version: newV, signalCount: newCmds.length, addressCount: newMods.length },
    summary: { added: added, deleted: deleted, modified: modified, unchanged: unchanged, items: summaryItems },
    metaChanges: metaChanges,
    commandRows: commandRows,
  };
}

/**
 * 对比相邻两个版本快照，生成变更事项概述
 */
function summarizeVersionChange(prev, curr) {
  const changes = [];
  const pCmds = new Map((prev.commands || []).map(c => [c.cmd, c]));
  const cCmds = new Map((curr.commands || []).map(c => [c.cmd, c]));
  const added = [...cCmds.keys()].filter(k => !pCmds.has(k)).map(k => cCmds.get(k).name);
  const removed = [...pCmds.keys()].filter(k => !cCmds.has(k)).map(k => pCmds.get(k).name);
  const modified = [...cCmds.keys()].filter(
    k => pCmds.has(k) && JSON.stringify(pCmds.get(k)) !== JSON.stringify(cCmds.get(k)),
  ).map(k => cCmds.get(k).name);
  if (added.length) changes.push(`新增命令：${added.join('、')}`);
  if (modified.length) changes.push(`修改命令：${modified.join('、')}`);
  if (removed.length) changes.push(`删除命令：${removed.join('、')}`);
  if (JSON.stringify(prev.moduleAddresses || []) !== JSON.stringify(curr.moduleAddresses || [])) {
    changes.push('模块地址变更');
  }
  ['fieldOrder', 'fieldConfig', 'endianness', 'checkType', 'checkStartField', 'checkEndField'].forEach(k => {
    if (JSON.stringify(prev[k]) !== JSON.stringify(curr[k])) changes.push('帧格式变更');
  });
  const unique = [...new Set(changes)];
  if (unique.length > 0) return unique.join('；');
  if ((prev.protoName || '') !== (curr.protoName || '')) return `协议更名为「${curr.protoName}」`;
  return '细节微调';
}

/**
 * 加载协议变更历史：protocol_versions 按时间升序逐版本取快照，
 * 评审人员通过 audit_logs.diff_json 中的版本号（"版本: vX.Y.Z"）匹配
 * @returns {Promise<Array<{no, changer, reviewer, summary}>>}
 */
async function loadExportHistory(state) {
  if (!hasElectron) return [];
  try {
    const vRes = await window.electronAPI.db.query(
      'SELECT version, config_json, created_by FROM protocol_versions WHERE protocol_name = ? ORDER BY id ASC',
      [state.protoName],
    );
    const versions = vRes.success && vRes.rows ? vRes.rows : [];

    const aRes = await window.electronAPI.db.query(
      'SELECT assignee, diff_json FROM audit_logs WHERE protocol_name = ? ORDER BY id ASC',
      [state.protoName],
    );
    const audits = aRes.success && aRes.rows ? aRes.rows : [];

    return versions.map((v, i) => {
      let summary = '初始版本';
      if (i > 0) {
        try {
          summary = summarizeVersionChange(JSON.parse(versions[i - 1].config_json), JSON.parse(v.config_json));
        } catch { summary = '配置变更'; }
      }
      const matched = audits.find(a => (a.diff_json || '').includes(`版本: ${v.version}`));
      return {
        no: i + 1,
        changer: v.created_by || '—',
        reviewer: (matched && matched.assignee) || '—',
        summary: `【${v.version}】${summary}`,
      };
    });
  } catch {
    return [];
  }
}

/* ===================== 导出：帧格式方框图 ===================== */

/**
 * 校验类型占用的字节数
 */
function checkByteCount(type) {
  if (!type || type === '无校验') return 0;
  if (type.startsWith('CRC32')) return 4;
  if (type.startsWith('CRC16')) return 2;
  return 1;
}

/**
 * 构建帧字节布局分段（供方框图渲染）
 * cmd 为 null 时生成通用帧格式（CMD/LEN/DATA 用占位符）；
 * 传入命令时填充实际命令字节、载荷长度与字段名
 */
function buildFrameSegments(state, cmd) {
  const segs = [];
  enabledFrameFields(state).forEach(({ key, def, cfg }) => {
    const count = cfg.byteCount === 'custom' ? (cfg.customCount || 1) : cfg.byteCount;
    const defaults = cfg.defaults || [];

    if (key === 'chk' && state.checkType === '无校验') return;

    if (key === 'data') {
      if (cmd) {
        if (isCmdVarlen(cmd)) {
          /* 变长模式：各字段名，变长字段用 (N) 标记 */
          const cells = [];
          (cmd.fields || []).forEach(f => {
            const fc = getFieldByteCount(f);
            if (fc > 0) {
              for (let i = 0; i < fc; i++) cells.push(f.name || '未命名');
            } else {
              cells.push(`${f.name || '变长'}(N)`);
            }
          });
          if (cells.length === 0) cells.push('变长数据');
          segs.push({ label: 'DATA', cells });
        } else {
          const n = getCmdPayloadLen(cmd);
          if (n <= 0) return;
          const cells = [];
          let idx = 0;
          (cmd.fields || []).forEach(f => {
            const fc = getFieldByteCount(f);
            for (let i = 0; i < fc; i++) cells.push(f.name || `D${idx}`);
            idx += fc;
          });
          while (cells.length < n) cells.push(`D${cells.length}`);
          segs.push({ label: 'DATA', cells });
        }
      } else {
        segs.push({ label: 'DATA', cells: ['D0', 'D1', '……'] });
      }
      return;
    }
    if (key === 'cmd') {
      /* 旧快照无 cmdBytes 时按字节位数从 cmd 数值展开（大端） */
      let cells;
      if (cmd && cmd.cmdBytes && cmd.cmdBytes.length > 0) {
        cells = [...cmd.cmdBytes];
      } else {
        const code = cmd ? parseInt(cmd.cmd, 16) || 0 : 0;
        cells = Array.from({ length: count }, (_, i) =>
          ((code >> ((count - 1 - i) * 8)) & 0xFF).toString(16).toUpperCase().padStart(2, '0'));
      }
      segs.push({ label: 'CMD', cells });
      return;
    }
    if (key === 'len') {
      let cells;
      if (cmd) {
        if (isCmdVarlen(cmd)) {
          /* 变长模式：LEN 值运行时确定 */
          cells = Array.from({ length: count }, () => 'N');
        } else {
          const n = getCmdPayloadLen(cmd);
          const hexStr = n.toString(16).toUpperCase().padStart(count * 2, '0');
          cells = hexStr.match(/.{2}/g) || [];
          if (state.endianness.includes('小端')) cells = cells.slice().reverse();
        }
      } else {
        cells = Array.from({ length: count }, () => 'LEN');
      }
      segs.push({ label: 'LEN', cells });
      return;
    }
    if (key === 'chk') {
      const n = checkByteCount(state.checkType);
      if (n <= 0) return;
      segs.push({ label: 'CHK', cells: Array.from({ length: n }, (_, i) => `C${i}`) });
      return;
    }
    /* sof/src/dst/ver/ctr/seq/tid/eof: 默认字节 */
    const cells = Array.from({ length: count }, (_, i) => defaults[i] || '00');
    segs.push({ label: def.abbr, cells });
  });
  return segs;
}

/**
 * 字符终端显示宽度（CJK 字符按 2 列计）
 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  }
  return w;
}

function truncateCellText(s, w) {
  if (dispWidth(s) <= w) return String(s);
  let out = '';
  let cw = 0;
  for (const ch of String(s)) {
    const cwid = ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
    if (cw + cwid > w - 1) break;
    out += ch;
    cw += cwid;
  }
  return out + '…';
}

function padCenterText(s, w) {
  const total = w - dispWidth(s);
  if (total <= 0) return String(s);
  const left = Math.floor(total / 2);
  return ' '.repeat(left) + s + ' '.repeat(total - left);
}

/**
 * 渲染帧方框图为等宽字符画（Markdown 代码块用）
 * 上排为字节格，下排为字段名（跨字节合并）
 */
function renderFrameDiagramMD(segs) {
  if (!segs.length) return '';
  const allCells = segs.flatMap(s => s.cells);
  let W = 4;
  allCells.forEach(c => { W = Math.max(W, dispWidth(c)); });
  W = Math.min(W, 12);

  /* 每个 cell 是否为分段起点（用于合并线绘制） */
  const isSegStart = [];
  segs.forEach(s => s.cells.forEach((_, i) => isSegStart.push(i === 0)));

  const cells = allCells.map(c => padCenterText(truncateCellText(c, W), W));
  const n = cells.length;
  const dash = '─'.repeat(W);

  const top = '┌' + cells.map(() => dash).join('┬') + '┐';
  const byteRow = '│' + cells.join('│') + '│';
  const mid = '├' + cells.map((_, i) =>
    dash + (i === n - 1 ? '┤' : (isSegStart[i + 1] ? '┼' : '┴')),
  ).join('');
  const labelRow = '│' + segs.map(s =>
    padCenterText(truncateCellText(s.label, W * s.cells.length), W * s.cells.length),
  ).join('│') + '│';
  const bottom = '└' + cells.map((_, i) =>
    dash + (i === n - 1 ? '┘' : (isSegStart[i + 1] ? '┴' : '─')),
  ).join('');

  return [top, byteRow, mid, labelRow, bottom].join('\n');
}

/**
 * 渲染帧方框图为 HTML 表格（PDF 用，上排字节格 + 下排跨列字段名）
 */
function renderFrameDiagramHTML(segs) {
  if (!segs.length) return '';
  const byteRow = segs
    .flatMap(s => s.cells)
    .map(c => `<td class="fd-byte">${escapeHtml(c)}</td>`)
    .join('');
  const labelRow = segs
    .map(s => `<td class="fd-label" colspan="${s.cells.length}">${escapeHtml(s.label)}</td>`)
    .join('');
  return `<table class="frame-diagram"><tr class="fd-bytes">${byteRow}</tr><tr class="fd-labels">${labelRow}</tr></table>`;
}

/**
 * 校验参数行（来自 checkParamsList，按当前校验类型）
 */
function checkInfoRows(state) {
  const item = checkParamsList.find(p => p.type === state.checkType);
  return item && item.rows ? item.rows : null;
}

/**
 * 构建 Markdown 协议文档
 * 结构: 基本信息 → 模块地址 → 帧格式（方框图 + 字段表 + 校验方式） → 每个命令（帧图 + 字段解析） → 变更历史
 */
function buildExportMD(state, history) {
  const L = [];
  const version = `v${state.versionMajor}.${state.versionMinor}.${state.versionPatch}`;
  const today = new Date().toISOString().slice(0, 10);

  L.push(`# ${state.protoName} 通信协议文档`, '');
  L.push(`> 版本 ${version} · 导出日期 ${today}`, '');
  if (state.protoDesc) L.push(`**描述**：${state.protoDesc}`, '');
  L.push(`**字节序**：${state.endianness}　**校验方式**：${state.checkType}（${state.checkStartField} → ${state.checkEndField}）`, '');

  /* 模块地址 */
  L.push('## 一、模块地址', '');
  L.push('| 模块名称 | 地址 |', '| --- | --- |');
  state.moduleAddresses.forEach(m => {
    L.push(`| ${m.name} | 0x${m.addressBytes.join(' ')} |`);
  });
  L.push('');

  /* 帧格式 */
  L.push('## 二、帧格式', '');
  const frameSegs = buildFrameSegments(state, null);
  if (frameSegs.length > 0) {
    L.push('```text');
    L.push(renderFrameDiagramMD(frameSegs));
    L.push('```', '');
  }
  L.push('| 字段 | 说明 | 字节数 | 默认值 |', '| --- | --- | --- | --- |');
  enabledFrameFields(state).forEach(({ key, def, cfg }) => {
    const count = key === 'data'
      ? '按命令'
      : String(cfg.byteCount === 'custom' ? (cfg.customCount || 1) : cfg.byteCount);
    const defaults = (cfg.defaults || []).join(' ');
    L.push(`| ${def.abbr} | ${def.name} | ${count} | ${hasDefaults(key) && defaults ? `0x${defaults}` : '—'} |`);
  });
  L.push('');

  /* 校验方式 */
  L.push('### 校验方式', '');
  const chkRows = checkInfoRows(state);
  if (state.checkType === '无校验' || !chkRows) {
    L.push('本协议未启用校验，帧中不包含校验字段。', '');
  } else {
    const chkN = checkByteCount(state.checkType);
    L.push(`本协议采用 **${state.checkType}** 校验，计算范围为 **${state.checkStartField} → ${state.checkEndField}**，校验字段占用 ${chkN} 字节。`, '');
    L.push('| 参数 | 值 |', '| --- | --- |');
    chkRows.forEach(r => L.push(`| ${r[0]} | ${r[1]} |`));
    L.push('');
  }

  /* 命令定义 */
  L.push(`## 三、命令定义（共 ${state.commands.length} 个）`, '');
  state.commands.forEach((cmd, ci) => {
    L.push(`### 3.${ci + 1} 命令 0x${cmd.cmdBytes.join('')} ${cmd.name}`, '');
    const dirLabel = cmd.dir === 'tx' ? '下行（TX）' : '上行（RX）';
    L.push(`- **方向**：${dirLabel}`);
    L.push(`- **发送方**：${cmd.sender || '—'}　**接收方**：${cmd.receiver || '—'}`);
    L.push(`- **载荷长度**：${getCmdPayloadLen(cmd)} 字节`);
    if (cmd.cycle && cmd.cycle !== '0') L.push(`- **执行周期**：${cmd.cycle} ms`);
    L.push('');

    /* 命令帧字节布局 */
    const cmdSegs = buildFrameSegments(state, cmd);
    if (cmdSegs.length > 0) {
      L.push('**帧字节布局**', '');
      L.push('```text');
      L.push(renderFrameDiagramMD(cmdSegs));
      L.push('```', '');
    }

    if (!cmd.fields || cmd.fields.length === 0) {
      L.push('*该命令无载荷字段*', '');
      return;
    }

    L.push('#### 载荷字段总览', '');
    L.push('| # | 字段名 | 类型 | 定义 |', '| --- | --- | --- | --- |');
    cmd.fields.forEach((f, fi) => {
      let def = '';
      if (f.type === 'bitfield') def = `${(f.bits || []).filter(b => b.one || b.zero).length} bit 定义`;
      else if (f.type === 'enum') def = `${(f.enumItems || []).length} 个枚举项`;
      else def = `原始值 0x${f.rawValue || '00'}`;
      L.push(`| ${fi + 1} | ${f.name} | ${fieldTypeLabel(f.type)} | ${def} |`);
    });
    L.push('');

    /* 每个信号的明细 */
    cmd.fields.forEach(f => {
      if (f.type === 'bitfield') {
        const bits = (f.bits || []).filter(b => b.one || b.zero);
        if (bits.length === 0) return;
        L.push(`**字段「${f.name}」位定义**`, '');
        L.push('| Bit | 置 0 含义 | 置 1 含义 |', '| --- | --- | --- |');
        bits.forEach(b => {
          L.push(`| bit${b.bit} | ${b.zero || '—'} | ${b.one || '—'} |`);
        });
        L.push('');
      } else if (f.type === 'enum') {
        const items = f.enumItems || [];
        if (items.length === 0) return;
        L.push(`**字段「${f.name}」枚举定义**`, '');
        L.push('| 值 | 含义 |', '| --- | --- |');
        items.forEach(it => {
          L.push(`| 0x${it.value} | ${it.meaning} |`);
        });
        L.push('');
      } else {
        L.push(`**字段「${f.name}」**：原始值 0x${f.rawValue || '00'}`, '');
      }
    });
  });

  /* 变更历史 */
  L.push('## 四、变更历史', '');
  if (history && history.length > 0) {
    L.push('| 序号 | 变更人 | 评审人员 | 更改事项概述 |', '| --- | --- | --- | --- |');
    history.forEach(h => {
      L.push(`| ${h.no} | ${h.changer} | ${h.reviewer} | ${h.summary} |`);
    });
  } else {
    L.push('*暂无历史变更记录（首次保存后自动生成）*');
  }
  L.push('');

  return L.join('\n');
}

/**
 * HTML 转义
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 构建 PDF 用的 HTML 协议文档（内联样式，A4 打印友好）
 * 结构与 Markdown 版一致: 基本信息 → 模块地址 → 帧格式（方框图 + 字段表 + 校验方式） → 每个命令 → 变更历史
 */
function buildExportHTML(state, history) {
  const version = `v${state.versionMajor}.${state.versionMinor}.${state.versionPatch}`;
  const today = new Date().toISOString().slice(0, 10);
  const P = [];
  const th = cells => `<tr>${cells.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const tr = cells => `<tr>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;

  P.push(`<h1>${escapeHtml(state.protoName)} 通信协议文档</h1>`);
  P.push(`<p class="meta">版本 ${escapeHtml(version)} · 导出日期 ${today}${state.protoDesc ? ' · ' + escapeHtml(state.protoDesc) : ''}</p>`);
  P.push(`<p class="meta">字节序：${escapeHtml(state.endianness)} ｜ 校验方式：${escapeHtml(state.checkType)}（${escapeHtml(state.checkStartField)} → ${escapeHtml(state.checkEndField)}）</p>`);

  /* 模块地址 */
  P.push('<h2>一、模块地址</h2>');
  P.push('<table>' + th(['模块名称', '地址']));
  state.moduleAddresses.forEach(m => {
    P.push(tr([m.name, '0x' + m.addressBytes.join(' ')]));
  });
  P.push('</table>');

  /* 帧格式 */
  P.push('<h2>二、帧格式</h2>');
  const frameSegs = buildFrameSegments(state, null);
  if (frameSegs.length > 0) {
    P.push(renderFrameDiagramHTML(frameSegs));
  }
  P.push('<table>' + th(['字段', '说明', '字节数', '默认值']));
  enabledFrameFields(state).forEach(({ key, def, cfg }) => {
    const count = key === 'data'
      ? '按命令'
      : String(cfg.byteCount === 'custom' ? (cfg.customCount || 1) : cfg.byteCount);
    const defaults = (cfg.defaults || []).join(' ');
    P.push(tr([def.abbr, def.name, count, hasDefaults(key) && defaults ? '0x' + defaults : '—']));
  });
  P.push('</table>');

  /* 校验方式 */
  P.push('<h3 class="chk-title">校验方式</h3>');
  const chkRows = checkInfoRows(state);
  if (state.checkType === '无校验' || !chkRows) {
    P.push('<p class="meta">本协议未启用校验，帧中不包含校验字段。</p>');
  } else {
    const chkN = checkByteCount(state.checkType);
    P.push(`<p class="meta">本协议采用 <b>${escapeHtml(state.checkType)}</b> 校验，计算范围为 <b>${escapeHtml(state.checkStartField)} → ${escapeHtml(state.checkEndField)}</b>，校验字段占用 ${chkN} 字节。</p>`);
    P.push('<table>' + th(['参数', '值']));
    chkRows.forEach(r => P.push(tr(r)));
    P.push('</table>');
  }

  /* 命令定义 */
  P.push(`<h2>三、命令定义（共 ${state.commands.length} 个）</h2>`);
  state.commands.forEach((cmd, ci) => {
    const dirLabel = cmd.dir === 'tx' ? '下行（TX）' : '上行（RX）';
    P.push(`<h3>3.${ci + 1} 命令 0x${cmd.cmdBytes.join('')} ${escapeHtml(cmd.name)}</h3>`);
    const cyclePart = cmd.cycle && cmd.cycle !== '0' ? ` ｜ 执行周期 ${cmd.cycle} ms` : '';
    P.push(`<p class="meta">方向：${dirLabel} ｜ 发送方：${escapeHtml(cmd.sender || '—')} ｜ 接收方：${escapeHtml(cmd.receiver || '—')} ｜ 载荷 ${getCmdPayloadLen(cmd)} 字节${cyclePart}</p>`);

    /* 命令帧字节布局 */
    const cmdSegs = buildFrameSegments(state, cmd);
    if (cmdSegs.length > 0) {
      P.push(renderFrameDiagramHTML(cmdSegs));
    }

    if (!cmd.fields || cmd.fields.length === 0) {
      P.push('<p class="empty">该命令无载荷字段</p>');
      return;
    }

    P.push('<table>' + th(['#', '字段名', '类型', '定义']));
    cmd.fields.forEach((f, fi) => {
      let def = '';
      if (f.type === 'bitfield') def = `${(f.bits || []).filter(b => b.one || b.zero).length} bit 定义`;
      else if (f.type === 'enum') def = `${(f.enumItems || []).length} 个枚举项`;
      else def = `原始值 0x${f.rawValue || '00'}`;
      P.push(tr([String(fi + 1), f.name, fieldTypeLabel(f.type), def]));
    });
    P.push('</table>');

    cmd.fields.forEach(f => {
      if (f.type === 'bitfield') {
        const bits = (f.bits || []).filter(b => b.one || b.zero);
        if (bits.length === 0) return;
        P.push(`<p class="sub">字段「${escapeHtml(f.name)}」位定义</p>`);
        P.push('<table>' + th(['Bit', '置 0 含义', '置 1 含义']));
        bits.forEach(b => {
          P.push(tr([`bit${b.bit}`, b.zero || '—', b.one || '—']));
        });
        P.push('</table>');
      } else if (f.type === 'enum') {
        const items = f.enumItems || [];
        if (items.length === 0) return;
        P.push(`<p class="sub">字段「${escapeHtml(f.name)}」枚举定义</p>`);
        P.push('<table>' + th(['值', '含义']));
        items.forEach(it => {
          P.push(tr(['0x' + it.value, it.meaning]));
        });
        P.push('</table>');
      } else {
        P.push(`<p class="sub">字段「${escapeHtml(f.name)}」：原始值 0x${escapeHtml(f.rawValue || '00')}</p>`);
      }
    });
  });

  /* 变更历史 */
  P.push('<h2>四、变更历史</h2>');
  if (history && history.length > 0) {
    P.push('<table>' + th(['序号', '变更人', '评审人员', '更改事项概述']));
    history.forEach(h => {
      P.push(tr([String(h.no), h.changer, h.reviewer, h.summary]));
    });
    P.push('</table>');
  } else {
    P.push('<p class="empty">暂无历史变更记录（首次保存后自动生成）</p>');
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    font-size: 12px; color: #1f2937; line-height: 1.65; padding: 10px 6px;
  }
  h1 { font-size: 20px; color: #111827; margin: 8px 0 10px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
  h2 { font-size: 15px; color: #1e3a8a; margin: 20px 0 8px; }
  h3 { font-size: 13px; color: #1f2937; margin: 16px 0 6px; background: #eff6ff; border-left: 3px solid #2563eb; padding: 4px 8px; }
  h3.chk-title { background: none; border-left: none; padding: 0; color: #1e3a8a; margin: 14px 0 4px; }
  p.meta { color: #6b7280; font-size: 11px; margin: 3px 0; }
  p.sub { color: #374151; font-size: 11.5px; margin: 10px 0 4px; font-weight: 600; }
  p.empty { color: #9ca3af; font-style: italic; margin: 6px 0; }
  table {
    width: 100%; border-collapse: collapse; margin: 6px 0 14px;
    page-break-inside: avoid; font-size: 11px;
  }
  th {
    background: #1e40af; color: #fff; font-weight: 600;
    padding: 5px 8px; text-align: left; border: 1px solid #1e3a8a;
  }
  td { padding: 4px 8px; border: 1px solid #d1d5db; vertical-align: top; }
  tr:nth-child(even) td { background: #f8fafc; }
  table.frame-diagram {
    width: auto; margin: 8px 0 14px; page-break-inside: avoid;
  }
  table.frame-diagram td {
    border: 1px solid #1e40af; padding: 4px 7px; text-align: center;
    background: #fff !important; vertical-align: middle;
    font-family: Consolas, "Courier New", monospace; font-size: 11px;
    min-width: 34px; color: #111827;
  }
  tr.fd-bytes td { font-weight: 600; }
  tr.fd-labels td {
    background: #eff6ff !important; color: #1e3a8a; font-weight: 700;
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  }
</style>
</head>
<body>
${P.join('\n')}
</body>
</html>`;
}

/**
 * 浏览器环境回退: Blob 下载（无 Electron 时）
 */
function downloadExportBlob(content, fileName) {
  const mimeMap = { json: 'application/json', md: 'text/markdown', pdf: 'text/html' };
  const blob = new Blob([content], { type: mimeMap[exportFormat.value] || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 确认导出: 按所选格式生成内容 → 原生保存对话框选择路径 → 写文件
 */
async function confirmExport() {
  const format = exportFormat.value;
  const state = captureEditorState();

  /* MD/PDF 需要变更历史表（protocol_versions + audit_logs） */
  const history = format === 'md' || format === 'pdf'
    ? await loadExportHistory(state)
    : null;

  let content = '';
  if (format === 'json') {
    content = JSON.stringify(buildExportData(state), null, 2);
  } else if (format === 'md') {
    content = buildExportMD(state, history);
  } else {
    content = buildExportHTML(state, history);
  }

  const fileName = `${exportBaseName.value}.${format}`;

  exporting.value = true;
  try {
    if (!hasElectron) {
      downloadExportBlob(content, fileName);
      exportDialog.show = false;
      showToast('协议已导出', 'success');
      return;
    }
    const res = await window.electronAPI.export.saveFile({
      defaultFileName: fileName,
      format,
      content,
    });
    if (res.success) {
      exportDialog.show = false;
      showToast(`已导出到 ${res.filePath}`, 'success');
    } else if (res.canceled) {
      /* 用户取消保存对话框，停留在导出弹窗 */
    } else {
      showToast(`导出失败: ${res.error}`, 'error');
    }
  } catch (e) {
    showToast(`导出失败: ${e.message}`, 'error');
  } finally {
    exporting.value = false;
  }
}

/**
 * 语义化版本号比较（v1.2.3 格式，忽略 v/V 前缀，缺失位按 0 处理）
 * @returns {number} a>b 返回正数，a<b 返回负数，相等返回 0
 */
function compareSemver(a, b) {
  const pa = String(a || '').replace(/^[vV]/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^[vV]/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 保存配置：将当前协议编辑器的内容写入数据库
 * 单事务原子写入 protocols / commands / modules / protocol_versions 四张表，
 * 任一步失败整体回滚，不会出现"协议在而命令字丢失"的中间态
 * config_json 字段保存完整的帧格式配置 JSON
 */
async function saveConfig() {
  saveStatus.value = '保存中...';

  /* 构造完整配置 JSON */
  const configJson = JSON.stringify({
    protoDesc: protoDesc.value,
    fieldOrder: fieldOrder.value,
    fieldConfig: Object.fromEntries(
      fieldOrder.value.map(k => [k, {
        ...fieldConfig[k],
        byteCount: getByteCount(k),
      }]),
    ),
    endianness: endianness.value,
    checkType: checkType.value,
    checkStartField: checkStartField.value,
    checkEndField: checkEndField.value,
  });

  const versionStr = `v${versionMajor.value}.${versionMinor.value}.${versionPatch.value}`;

  try {
    if (hasElectron) {
      const curProto = protocolList.value.find(p => p.name === activeProtocol.value);
      /* 远程模式下：保存的是本地草稿，草稿是本地独占的，
       * 跳过所有服务器端预检查（乐观锁/重名/版本号都查的是服务器，和草稿无关） */
      const savingAsDraft = isRemoteMode.value;

      if (!savingAsDraft) {
        /* 乐观锁预检查（快速反馈，减少无谓写入；残余竞态由事务内 CAS 守卫兜底）：
         * 数据库中该协议的 id 与编辑器加载时不一致 → 已被他人替换保存；
         * 查不到行 → 已被他人删除。两种情况都弹冲突框 */
        if (editorLoadedProtoId.value != null) {
          const lockRes = await window.electronAPI.db.query(
            'SELECT id FROM protocols WHERE name = ?',
            [activeProtocol.value],
          );
          /* 查询失败（网络等）时跳过预检查，由事务内 CAS 守卫兜底，避免误报冲突 */
          if (lockRes.success) {
            const dbId = lockRes.rows && lockRes.rows.length > 0 ? lockRes.rows[0].id : null;
            if (dbId !== editorLoadedProtoId.value) {
              updateSaveStatusText();
              conflictDialog.show = true;
              return;
            }
          }
        }

        /* 重名预检查：新名称已被其他协议占用则拒绝保存（涵盖新协议撞名、重命名撞他人协议）
         * 唯一索引 idx_protocols_name 是并发竞态的最终防线，此处提供友好提示 */
        {
          const dupRes = await window.electronAPI.db.query(
            'SELECT id FROM protocols WHERE name = ?',
            [protoName.value],
          );
          if (dupRes.success && dupRes.rows && dupRes.rows.length > 0
            && dupRes.rows[0].id !== editorLoadedProtoId.value) {
            updateSaveStatusText();
            showToast(`协议名称「${protoName.value}」已存在，请更换名称`, 'error');
            return;
          }
        }

        /* 版本号单调性预检查：禁止降级保存（如 v3.2.1 存回 v1.0.0），保持历史可追溯
         * 取数据库当前行版本与最新快照版本中的语义最大值作为基准；
         * 首次保存的新协议无历史版本，跳过 */
        if (editorLoadedProtoId.value != null) {
          const curRes = await window.electronAPI.db.query(
            'SELECT version FROM protocols WHERE name = ?',
            [activeProtocol.value],
          );
          const histRes = await window.electronAPI.db.query(
            'SELECT version FROM protocol_versions WHERE protocol_name = ? ORDER BY id DESC LIMIT 1',
            [activeProtocol.value],
          );
          const baseline = Math.max(
            curRes.success && curRes.rows && curRes.rows.length > 0
              ? compareSemver(curRes.rows[0].version, versionStr) : 1,
            histRes.success && histRes.rows && histRes.rows.length > 0
              ? compareSemver(histRes.rows[0].version, versionStr) : 1,
          );
          if (baseline > 0) {
            const highest = (curRes.success && curRes.rows && curRes.rows.length > 0
              && compareSemver(curRes.rows[0].version, versionStr) > 0)
              ? curRes.rows[0].version
              : (histRes.rows && histRes.rows.length > 0 ? histRes.rows[0].version : versionStr);
            updateSaveStatusText();
            showToast(`版本号不能低于历史最高版本 ${highest}（当前输入 ${versionStr}）`, 'error');
            return;
          }
        }
      }

      /* 预读最新版本快照，判断内容是否有变化（在事务外只读，不影响原子性）
       * 用原名称 activeProtocol 定位：重命名迁移在本事务内执行，旧快照此刻仍挂在原名称下 */
      const snapshotJson = JSON.stringify(captureEditorState());
      let snapshotUnchanged = false;
      const lastSnap = await window.electronAPI.db.query(
        'SELECT config_json FROM protocol_versions WHERE protocol_name = ? ORDER BY id DESC LIMIT 1',
        [activeProtocol.value],
      );
      if (lastSnap.success && lastSnap.rows && lastSnap.rows.length > 0) {
        snapshotUnchanged = lastSnap.rows[0].config_json === snapshotJson;
      }

      /* 单事务原子写入：子表清理 → 主表重建 → 子表重建 → 快照归属迁移 → 版本快照
       * 全部语句放进同一个 batch（本地 better-sqlite3 事务 / 远程服务器 BEGIN/COMMIT），
       * 任一步失败整体回滚，杜绝"协议在而命令字、模块地址丢失"的中间态
       * 注：SQLite 的 PRAGMA foreign_keys 默认关闭，ON DELETE CASCADE 不生效，
       *     必须显式 DELETE 子表，否则旧行成为孤儿数据随保存次数无限累积
       * CAS 乐观锁：已保存过的协议按加载时的行 id 定位删除，expectChanges:1 校验；
       *     事务提交前若该行已被他人替换/删除，影响行数为 0 → 整体回滚并弹冲突框。
       *     检查与写入在同一事务内，彻底关闭上方预检查的 TOCTOU 竞态窗口 */
      const statements = [];
      const expectedId = editorLoadedProtoId.value;
      const useIdDelete = expectedId != null && !isRemoteMode.value;
      let insertProtoIdx = -1;

      if (useIdDelete) {
        /* 已有协议：UPDATE 原地更新（保留 id、current_version_id 不变） */

        /* 1. 清理命令字子表 */
        statements.push({ sql: 'DELETE FROM commands WHERE protocol_id = ?', params: [expectedId] });

        /* 2. 清理模块地址子表 */
        statements.push({ sql: 'DELETE FROM modules WHERE protocol_id = ?', params: [expectedId] });

        /* 3. UPDATE 主表行（CAS：id + 原名称双条件，行被替换/删除时影响 0 行 → 回滚） */
        statements.push({
          sql: `UPDATE protocols SET name = ?, version = ?, byte_order = ?, check_method = ?, check_start = ?, check_end = ?, config_json = ?, updated_at = datetime('now','localtime') WHERE id = ? AND name = ?`,
          params: [
            protoName.value,
            versionStr,
            endianness.value.includes('小端') ? 'little' : 'big',
            checkType.value,
            checkStartField.value,
            checkEndField.value,
            configJson,
            expectedId,
            activeProtocol.value,
          ],
          expectChanges: 1,
        });

        /* 4. 重建命令字（用 expectedId 直接关联，不用子查询按名查） */
        commands.value.forEach(cmd => statements.push({
          sql: `INSERT INTO commands (protocol_id, code, name, sender, receiver, period_ms, direction, config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [expectedId, cmd.cmd, cmd.name, cmd.sender || '', cmd.receiver || '', parseInt(cmd.cycle) || 0, cmd.dir === 'tx' ? 'send' : 'recv', JSON.stringify(cmd)],
        }));

        /* 5. 重建模块地址 */
        moduleAddresses.value.forEach(mod => statements.push({
          sql: 'INSERT INTO modules (protocol_id, name, address) VALUES (?, ?, ?)',
          params: [expectedId, mod.name, mod.addressBytes.join(' ')],
        }));

        /* 6. 版本行归属修复 + 重命名迁移（每次保存都执行，幂等）：
         *    旧版保存逻辑（DELETE+INSERT 重建协议行）留下的历史版本行 protocol_id 断裂/为 NULL，
         *    按"编辑器加载时的协议名"（activeProtocol，此刻仍是旧名）认领这些行并修复 protocol_id；
         *    重命名场景同时把版本行名字迁移到新名称。不修复的话改名后 diff 永远查不到历史版本 */
        statements.push({
          sql: 'UPDATE protocol_versions SET protocol_name = ?, protocol_id = ? WHERE protocol_id = ? OR protocol_name = ?',
          params: [protoName.value, expectedId, expectedId, activeProtocol.value],
        });

        /* 7. 写入版本快照（带 protocol_id，status=draft） */
        if (!snapshotUnchanged) {
          statements.push({
            sql: 'INSERT INTO protocol_versions (protocol_id, protocol_name, version, config_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            params: [expectedId, protoName.value, versionStr, snapshotJson, 'draft', currentUser.value?.name || ''],
          });
        }
      } else {
        /* 新协议：INSERT 新行 */

        /* 1. 清理命令字子表（按名称，防止重名残留） */
        statements.push({ sql: 'DELETE FROM commands WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [activeProtocol.value] });

        /* 2. 清理模块地址子表 */
        statements.push({ sql: 'DELETE FROM modules WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [activeProtocol.value] });

        /* 3. 删除旧协议主表行 */
        statements.push({ sql: 'DELETE FROM protocols WHERE name = ?', params: [activeProtocol.value] });

        /* 4. 插入协议主表 */
        insertProtoIdx = statements.length;
        statements.push({
          sql: `INSERT INTO protocols (name, version, byte_order, check_method, check_start, check_end, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params: [
            protoName.value,
            versionStr,
            endianness.value.includes('小端') ? 'little' : 'big',
            checkType.value,
            checkStartField.value,
            checkEndField.value,
            configJson,
          ],
        });

        /* 5. 重建命令字 */
        commands.value.forEach(cmd => statements.push({
          sql: `INSERT INTO commands (protocol_id, code, name, sender, receiver, period_ms, direction, config_json) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?, ?, ?, ?, ?, ?)`,
          params: [protoName.value, cmd.cmd, cmd.name, cmd.sender || '', cmd.receiver || '', parseInt(cmd.cycle) || 0, cmd.dir === 'tx' ? 'send' : 'recv', JSON.stringify(cmd)],
        }));

        /* 6. 重建模块地址 */
        moduleAddresses.value.forEach(mod => statements.push({
          sql: 'INSERT INTO modules (protocol_id, name, address) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?)',
          params: [protoName.value, mod.name, mod.addressBytes.join(' ')],
        }));

        /* 7. 写入版本快照（protocol_id 子查询取本事务新插入的协议行） */
        if (!snapshotUnchanged) {
          statements.push({
            sql: 'INSERT INTO protocol_versions (protocol_id, protocol_name, version, config_json, status, created_by) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?, ?, ?, ?)',
            params: [protoName.value, protoName.value, versionStr, snapshotJson, 'draft', currentUser.value?.name || ''],
          });
        }
      }

      /* 远程模式下保存到本地草稿库（不写入服务器），本地模式正常写入 */
      let batchResult;
      if (isRemoteMode.value) {
        if (!window.electronAPI.draft) {
          /* 防御性检查：draft API 不可用（通常是主进程未重启），
           * 禁止直接写入服务器，避免绕过审核流程 */
          updateSaveStatusText();
          showToast('草稿功能暂不可用，请重启应用后重试', 'error');
          return;
        }
        batchResult = await window.electronAPI.draft.save(statements, protoName.value);
      } else {
        /* 本地模式：直接写入数据库 */
        batchResult = await window.electronAPI.db.batch(statements);
      }

      if (!batchResult.success) {
        const errText = String(batchResult.error || '');
        if (errText.includes('CAS_CONFLICT')) {
          saveStatus.value = isRemoteMode.value ? '保存草稿' : '保存配置';
          conflictDialog.show = true;
          return;
        }
        /* 唯一索引兜底：预检后、写入前的窗口内被他人抢先占用名称（竞态概率极低） */
        if (errText.includes('UNIQUE constraint failed: protocols.name')) {
          saveStatus.value = isRemoteMode.value ? '保存草稿' : '保存配置';
          showToast(`协议名称「${protoName.value}」刚被其他成员占用，请更换名称后重试`, 'error');
          return;
        }
        throw new Error(batchResult.error);
      }

      /* 保存成功后更新乐观锁标记 */
      let newDbId;
      if (useIdDelete) {
        /* UPDATE 路径：id 不变 */
        newDbId = expectedId;
      } else {
        /* INSERT 路径：取新插入行的自增 id */
        newDbId = batchResult.results[insertProtoIdx].lastInsertRowid;
      }
      editorLoadedProtoId.value = newDbId;

      /* 用 activeProtocol 定位列表项，更新为编辑器中的新值（dbId 同步为新的行 id，
       * 首次保存的草稿/内存协议从此进入 CAS 保护的协议集合） */
      const idx = protocolList.value.findIndex(p => p.name === activeProtocol.value);
      if (idx !== -1) {
        protocolList.value[idx] = {
          ...protocolList.value[idx],
          name: protoName.value,
          version: versionStr,
          status: '已启用',
          draft: isRemoteMode.value,
          dbId: newDbId,
          config: captureEditorState(),
          /* 远程模式保存草稿：内容已与最后一次审核提交的版本不同，
           * 旧的审核状态（已通过/已生效）不再代表当前草稿，重置为待提交 */
          ...(isRemoteMode.value ? { reviewStatus: null, changeId: null, draftDirty: true } : {}),
        };
      }
      activeProtocol.value = protoName.value;
    } else {
      /* 无 Electron 环境：仅在内存中更新列表 */
      const idx = protocolList.value.findIndex(p => p.name === activeProtocol.value);
      if (idx !== -1) {
        protocolList.value[idx] = {
          ...protocolList.value[idx],
          name: protoName.value,
          version: versionStr,
          status: '已启用',
          draft: false,
          config: captureEditorState(),
        };
      }
      activeProtocol.value = protoName.value;
    }

    updateSaveStatusText();
    savedSnapshot.value = captureEditorState();
    showToast(isRemoteMode.value ? '草稿已保存' : '保存成功', 'success');
  } catch (err) {
    updateSaveStatusText();
    showToast('保存失败', 'error');
  }
}

/**
 * 从数据库加载协议列表
 * 查询 protocols 表 + 关联的 commands 和 modules，构建内存列表
 */
/**
 * 从数据库行解析协议配置（通用，适用于服务器正式版和本地草稿）
 */
async function parseProtocolFromRow(p, queryFn) {
  let config = null;
  try {
    const parsed = JSON.parse(p.config_json || '{}');
    const vParts = (p.version || 'v1.0.0').replace(/^v/, '').split('.');
    config = {
      protoName: p.name,
      protoDesc: parsed.protoDesc || '',
      versionMajor: parseInt(vParts[0]) || 1,
      versionMinor: parseInt(vParts[1]) || 0,
      versionPatch: parseInt(vParts[2]) || 0,
      fieldOrder: parsed.fieldOrder || ['sof', 'src', 'dst', 'ver', 'cmd', 'ctr', 'seq', 'tid', 'len', 'data', 'chk', 'eof'],
      fieldConfig: parsed.fieldConfig || defaultEditorState(p.name).fieldConfig,
      endianness: parsed.endianness || (p.byte_order === 'little' ? '小端 (Little-Endian)' : '大端 (Big-Endian)'),
      checkType: parsed.checkType || p.check_method || 'CRC16-MODBUS',
      checkStartField: parsed.checkStartField || p.check_start || 'SOF',
      checkEndField: parsed.checkEndField || p.check_end || 'DATA',
      moduleAddresses: [],
      commands: [],
    };
  } catch (e) {
    return null;
  }

  /* 查询关联的命令字 */
  const cmdResult = await queryFn(
    'SELECT * FROM commands WHERE protocol_id = ? ORDER BY id',
    [p.id],
  );
  if (cmdResult.success && cmdResult.rows) {
    config.commands = cmdResult.rows.map(c => {
      let cmdData = {};
      try { cmdData = JSON.parse(c.config_json || '{}'); } catch (e) { /* ignore */ }
      const cmdBytes = cmdData.cmdBytes || [c.code.replace('0x', '')];
      return {
        cmd: c.code,
        cmdBytes,
        name: c.name,
        sender: c.sender || '',
        receiver: c.receiver || '',
        dir: c.direction === 'send' ? 'tx' : 'rx',
        cycle: String(c.period_ms || 0),
        fields: cmdData.fields || [],
      };
    });
  }

  /* 查询关联的模块地址 */
  const modResult = await queryFn(
    'SELECT * FROM modules WHERE protocol_id = ? ORDER BY id',
    [p.id],
  );
  if (modResult.success && modResult.rows) {
    config.moduleAddresses = modResult.rows.map(m => ({
      name: m.name,
      addressBytes: m.address ? m.address.split(' ') : ['00'],
    }));
  }

  if (config.moduleAddresses.length === 0) {
    config.moduleAddresses = [{ name: '主控制器', addressBytes: ['01'] }];
  }
  if (config.commands.length === 0) {
    config.commands = [{
      cmd: '0x01', cmdBytes: ['01'], name: '新命令',
      sender: '', receiver: '', dir: 'tx', cycle: '0', fields: [],
    }];
  }

  return config;
}

/**
 * 从指定数据源加载协议列表并解析为协议列表项
 * @param {Function} queryFn - 查询函数 (sql, params) => { success, rows }
 * @param {boolean} isDraft - 是否为草稿
 */
async function loadProtocolsFromSource(queryFn, isDraft) {
  const protoResult = await queryFn('SELECT * FROM protocols ORDER BY id');
  if (!protoResult.success || !protoResult.rows || protoResult.rows.length === 0) {
    return [];
  }

  const items = [];
  for (const p of protoResult.rows) {
    const config = await parseProtocolFromRow(p, queryFn);
    if (!config) continue;

    /* 查询审核状态（始终走服务器 db.query，因为 audit_logs 在服务器） */
    let reviewStatus = null;
    let changeId = null;
    let auditTime = '';
    try {
      const auditResult = await window.electronAPI.db.query(
        'SELECT change_id, status, created_at FROM audit_logs WHERE protocol_name = ? ORDER BY id DESC LIMIT 1',
        [p.name],
      );
      if (auditResult.success && auditResult.rows && auditResult.rows.length > 0) {
        reviewStatus = auditResult.rows[0].status;
        changeId = auditResult.rows[0].change_id;
        auditTime = auditResult.rows[0].created_at || '';
      }
    } catch { /* ignore */ }

    items.push({
      uid: p.id,
      dbId: p.id,
      name: p.name,
      status: '已启用',
      draft: isDraft,
      version: p.version || 'v1.0.0',
      reviewStatus,
      changeId,
      auditTime,
      project: p.project || '',
      config,
    });
  }
  return items;
}

/**
 * 从本地草稿库加载所有草稿协议
 */
async function loadDraftProtocols() {
  if (!window.electronAPI.draft) return [];
  try {
    const listResult = await window.electronAPI.draft.list();
    if (!listResult.success || !listResult.rows || listResult.rows.length === 0) return [];

    const items = [];
    for (const p of listResult.rows) {
      const detail = await window.electronAPI.draft.get(p.name);
      if (!detail.success) continue;

      let config = null;
      try {
        const parsed = JSON.parse(detail.proto.config_json || '{}');
        const vParts = (detail.proto.version || 'v1.0.0').replace(/^v/, '').split('.');
        config = {
          protoName: detail.proto.name,
          protoDesc: parsed.protoDesc || '',
          versionMajor: parseInt(vParts[0]) || 1,
          versionMinor: parseInt(vParts[1]) || 0,
          versionPatch: parseInt(vParts[2]) || 0,
          fieldOrder: parsed.fieldOrder || ['sof', 'src', 'dst', 'ver', 'cmd', 'ctr', 'seq', 'tid', 'len', 'data', 'chk', 'eof'],
          fieldConfig: parsed.fieldConfig || defaultEditorState(detail.proto.name).fieldConfig,
          endianness: parsed.endianness || (detail.proto.byte_order === 'little' ? '小端 (Little-Endian)' : '大端 (Big-Endian)'),
          checkType: parsed.checkType || detail.proto.check_method || 'CRC16-MODBUS',
          checkStartField: parsed.checkStartField || detail.proto.check_start || 'SOF',
          checkEndField: parsed.checkEndField || detail.proto.check_end || 'DATA',
          moduleAddresses: [],
          commands: [],
        };
      } catch {
        continue;
      }

      /* 命令字 */
      config.commands = (detail.commands || []).map(c => {
        let cmdData = {};
        try { cmdData = JSON.parse(c.config_json || '{}'); } catch { /* ignore */ }
        const cmdBytes = cmdData.cmdBytes || [c.code.replace('0x', '')];
        return {
          cmd: c.code,
          cmdBytes,
          name: c.name,
          sender: c.sender || '',
          receiver: c.receiver || '',
          dir: c.direction === 'send' ? 'tx' : 'rx',
          cycle: String(c.period_ms || 0),
          fields: cmdData.fields || [],
        };
      });

      /* 模块地址 */
      config.moduleAddresses = (detail.modules || []).map(m => ({
        name: m.name,
        addressBytes: m.address ? m.address.split(' ') : ['00'],
      }));

      if (config.moduleAddresses.length === 0) {
        config.moduleAddresses = [{ name: '主控制器', addressBytes: ['01'] }];
      }
      if (config.commands.length === 0) {
        config.commands = [{
          cmd: '0x01', cmdBytes: ['01'], name: '新命令',
          sender: '', receiver: '', dir: 'tx', cycle: '0', fields: [],
        }];
      }

      items.push({
        uid: detail.proto.id,
        dbId: detail.proto.id,
        name: detail.proto.name,
        status: '已启用',
        draft: true,
        version: detail.proto.version || 'v1.0.0',
        reviewStatus: null, /* 审核状态从服务器查，下面合并时补 */
        changeId: null,
        draftUpdatedAt: detail.proto.updated_at || '', /* 用于和审核记录时间比较 */
        project: detail.proto.project || '',
        config,
      });
    }
    return items;
  } catch {
    return [];
  }
}

async function loadProtocolsFromDB() {
  if (!hasElectron) return;

  try {
    let serverProtocols = [];
    let draftProtocols = [];

    if (isRemoteMode.value && window.electronAPI.draft) {
      /* 远程模式：从服务器加载正式版 + 从本地加载草稿 */
      serverProtocols = await loadProtocolsFromSource(
        (sql, params) => window.electronAPI.db.query(sql, params),
        false,
      );
      draftProtocols = await loadDraftProtocols();
    } else {
      /* 本地模式：直接从本地数据库加载 */
      serverProtocols = await loadProtocolsFromSource(
        (sql, params) => window.electronAPI.db.query(sql, params),
        false,
      );
    }

    /* 合并：草稿覆盖同名正式版（用户编辑的是草稿） */
    const merged = new Map();
    for (const p of serverProtocols) {
      merged.set(p.name, p);
    }
    for (const d of draftProtocols) {
      const existing = merged.get(d.name);
      if (existing) {
        /* 草稿覆盖正式版内容；审核状态按保存时间与审核提交时间比较：
         * 草稿保存晚于最后一次审核提交 → 草稿已偏离被审核版本 → 待重新提交；
         * 否则沿用服务器审核状态（草稿即提交审核的那个版本）。
         * 时间均截断到分钟：草稿 updated_at 为 "YYYY-MM-DD HH:MM:SS"，
         * 审核 created_at 为 "YYYY-MM-DD HH:MM"，同分钟内先保存后提交视为未偏离 */
        const draftMin = (d.draftUpdatedAt || '').slice(0, 16);
        const auditMin = (existing.auditTime || '').slice(0, 16);
        const draftNewer = draftMin && auditMin && draftMin > auditMin;
        merged.set(d.name, {
          ...d,
          reviewStatus: draftNewer ? null : existing.reviewStatus,
          changeId: draftNewer ? null : existing.changeId,
          draftDirty: draftNewer,
        });
      } else {
        merged.set(d.name, d);
      }
    }

    const newList = Array.from(merged.values());
    if (newList.length === 0) return;

    protocolList.value = newList;
    const first = newList[0];
    activeProtocol.value = first.name;
    restoreEditorState(first.config);
    editorLoadedProtoId.value = first.dbId ?? null;
  } catch (err) {
    /* 加载失败，保留默认内存列表 */
  }
}

/* 组件挂载时从数据库加载协议列表并初始化已保存快照 */
onMounted(async () => {
  await checkRemoteMode();
  updateSaveStatusText();
  await loadProtocolsFromDB();
  await loadProjectList();
  savedSnapshot.value = captureEditorState();
  /* 如果审核队列已加载，立即同步一次最新状态 */
  if (reviewLoaded.value) {
    syncReviewStatusToProtocols();
  }
});

/* 用户切换时重新从数据库加载协议列表（获取最新审核状态） */
watch(currentUser, async (newUser, oldUser) => {
  if (newUser && newUser !== oldUser) {
    await loadProtocolsFromDB();
    savedSnapshot.value = captureEditorState();
  }
}, { deep: true });
</script>

<style scoped>
/* 项目标签 */
.protocol-tag.project-tag {
  background: rgba(96, 165, 250, 0.15);
  color: #60a5fa;
  cursor: pointer;
}
.protocol-tag.project-tag:hover {
  background: rgba(96, 165, 250, 0.3);
}

/* 项目筛选条 */
.project-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  margin-bottom: 8px;
  background: rgba(96, 165, 250, 0.1);
  border: 1px solid rgba(96, 165, 250, 0.3);
  border-radius: 4px;
  font-size: 12px;
  color: #60a5fa;
  cursor: pointer;
}
.filter-clear { font-size: 16px; font-weight: 700; }

/* 归档弹窗 */
.archive-dialog { width: 420px; max-width: 90vw; }
.archive-dialog .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px 10px; }
.archive-dialog .modal-close {
  background: none; border: none; color: var(--text-tertiary, #6b7280);
  cursor: pointer; padding: 4px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.archive-dialog .modal-close:hover { color: var(--accent-color, #f59e0b); background: var(--bg-tertiary, #2a2a3e); }
.archive-dialog .modal-body { padding: 16px 20px; }

.archive-proto-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-color, #f59e0b);
  margin-bottom: 16px;
}

.archive-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary, #6b7280);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.archive-project-list {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 4px;
}
.archive-project-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #2d2d3f);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary, #9ca3af);
  transition: all 0.15s;
}
.archive-project-item:hover {
  border-color: var(--accent-color, #f59e0b);
  background: var(--bg-tertiary, #2a2a3e);
}
.archive-project-item.active {
  border-color: var(--accent-color, #f59e0b);
  background: rgba(245, 158, 11, 0.1);
  color: var(--accent-color, #f59e0b);
}
.archive-project-item svg.archive-project-icon { margin-right: 0; flex-shrink: 0; }
.archive-project-item svg:not(.archive-project-icon) { margin-left: auto; }
.archive-empty {
  text-align: center;
  padding: 24px 12px;
  color: var(--text-tertiary, #6b7280);
  font-size: 12px;
  border: 1px dashed var(--border-color, #2d2d3f);
  border-radius: 6px;
}

.archive-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
  color: var(--text-tertiary, #6b7280);
  font-size: 11px;
}
.archive-divider::before, .archive-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-color, #2d2d3f);
}

.archive-new-btn-wrap {
  margin-top: 12px;
  display: flex;
  justify-content: center;
}
.archive-new-btn {
  gap: 6px;
  width: 100%;
  justify-content: center;
  border: 1px dashed var(--border-color, #2d2d3f);
}
.archive-new-btn:hover {
  border-color: var(--accent-color, #f59e0b);
  color: var(--accent-color, #f59e0b);
}

.archive-input-wrap {
  position: relative;
  margin-top: 12px;
}
.archive-input {
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
}
.archive-input-hint {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: #22c55e;
}
.proj-color-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  cursor: pointer;
  transition: transform 0.15s ease;
}
.proj-color-dot:hover {
  transform: scale(1.3);
  box-shadow: 0 0 0 2px rgba(255,255,255,0.3);
}
.inline-color-picker {
  display: inline-flex;
  gap: 4px;
  padding: 4px 6px;
  background: var(--bg-tertiary, #1e1e2e);
  border: 1px solid var(--border-color, #2d2d3f);
  border-radius: 8px;
  margin-left: 4px;
  z-index: 10;
}
.color-dot.sm {
  width: 16px;
  height: 16px;
  border-width: 2px;
}
.color-dot.sm.more-color {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary, #1e1e2e);
  color: var(--text-tertiary, #6b6b80);
  cursor: pointer;
  position: relative;
  overflow: hidden;
}
.color-dot.sm.more-color:hover {
  color: var(--accent-color, #f59e0b);
}
.color-dot.sm.more-color input[type="color"] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
}
.color-picker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.color-picker-label {
  font-size: 12px;
  color: var(--text-tertiary, #6b6b80);
  white-space: nowrap;
}
.color-picker {
  display: flex;
  gap: 6px;
}
.color-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.color-dot:hover {
  transform: scale(1.15);
}
.color-dot.selected {
  border-color: white;
  transform: scale(1.15);
}

/* 项目分组 */
.project-group {
  margin-bottom: 12px;
}
.project-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--group-color, #3b82f6) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--group-color, #3b82f6) 40%, transparent);
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  font-weight: 600;
  color: color-mix(in srgb, var(--group-color, #3b82f6) 85%, white);
  transition: all 0.15s ease;
}
.project-group-header:hover {
  border-color: var(--group-color, #3b82f6);
  background: color-mix(in srgb, var(--group-color, #3b82f6) 18%, transparent);
}
.group-color-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.group-chevron {
  transition: transform 0.2s ease;
  flex-shrink: 0;
}
.group-chevron.collapsed {
  transform: rotate(-90deg);
}
/* 面板级折叠：向左折叠成细条，编辑区占满剩余空间 */
.protocol-config-grid.list-folded {
  grid-template-columns: 52px minmax(0, 1fr);
}
.protocol-list .panel-header {
  justify-content: flex-start;
  gap: 8px;
}
.protocol-list .panel-header .input.search {
  margin-left: auto;
}
.list-chevron {
  cursor: pointer;
  color: var(--text-secondary);
  transform: rotate(90deg); /* 展开时箭头朝左，提示向左折叠 */
}
.list-chevron:hover {
  color: var(--text-primary);
}
.list-chevron.collapsed {
  transform: rotate(-90deg); /* 折叠后箭头朝右，点击展开 */
}
.list-title {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.protocol-config-grid.list-folded .protocol-list .panel-header {
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  gap: 14px;
  padding: 12px 4px;
  height: 100%;
  box-sizing: border-box;
}
.protocol-config-grid.list-folded .list-title,
.protocol-config-grid.list-folded .input.search {
  display: none;
}
.folded-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
  flex: 1;
  overflow-y: auto;
  padding: 2px 0;
  scrollbar-width: thin;
}
.folded-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--pc, var(--accent)) 22%, #0b1322);
  border: 2px solid transparent;
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  user-select: none;
  transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
}
.folded-avatar:hover {
  transform: scale(1.12);
}
.folded-avatar.active {
  border-color: var(--pc, var(--accent));
  box-shadow: 0 0 9px color-mix(in srgb, var(--pc, var(--accent)) 45%, transparent);
}
.group-name {
  flex: 1;
}
.group-count {
  font-size: 11px;
  font-weight: 400;
  padding: 2px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--group-color, #3b82f6) 20%, transparent);
  color: color-mix(in srgb, var(--group-color, #3b82f6) 70%, white);
}
.project-group-body {
  padding-top: 8px;
}
.project-group-body .protocol-card {
  margin-bottom: 8px;
  background: color-mix(in srgb, var(--group-color, #3b82f6) 5%, var(--bg-secondary, #1a1a2e));
  border-left: 3px solid var(--group-color, #3b82f6);
}
</style>

<style>
/* 右键上下文菜单（非 scoped，因 Teleport 挂载到 body） */
.ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 160px;
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border-color, #2d2d3f);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 4px;
}
.ctx-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-secondary, #9ca3af);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}
.ctx-menu-item:hover {
  background: var(--bg-tertiary, #2a2a3e);
  color: var(--accent-color, #f59e0b);
}
</style>
