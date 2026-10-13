<template>
  <div class="view">
    <div class="view-header">
      <div>
        <h1 class="view-title">协议变更审核</h1>
        <p class="view-subtitle">审查、批准或回退协议配置的变更</p>
      </div>
      <div class="view-actions">
        <button class="btn btn-secondary" @click="refreshList" :disabled="refreshing">
          {{ refreshing ? '刷新中...' : '刷新' }}
        </button>
        <button class="btn btn-secondary" @click="exportAuditLog">导出审计日志</button>
      </div>
    </div>

    <!-- Toast 提示 -->
    <Transition name="toast-slide">
      <div v-if="toast.show" class="save-toast" :class="toast.type">
        <span class="toast-icon">{{ toast.type === 'success' ? '✓' : '✕' }}</span>
        <span class="toast-text">{{ toast.message }}</span>
      </div>
    </Transition>

    <div class="panel">
      <div class="panel-header audit-filter-bar">
        <h3>审核列表</h3>
        <div class="audit-filters">
          <div class="filter-group">
            <button
              v-for="tab in scopeTabs"
              :key="tab.value"
              :class="['tab', { active: activeScope === tab.value }]"
              @click="activeScope = tab.value"
            >{{ tab.label }}</button>
          </div>
          <span class="filter-divider"></span>
          <div class="filter-group">
            <button
              v-for="tab in filterTabs"
              :key="tab.value"
              :class="['tab', { active: activeFilter === tab.value }]"
              @click="activeFilter = tab.value"
            >{{ tab.label }}</button>
          </div>
        </div>
      </div>
      <div class="panel-body">
        <table class="data-table audit-table">
          <thead>
            <tr>
              <th>变更单号</th>
              <th>协议名称</th>
              <th>变更类型</th>
              <th>申请人</th>
              <th>审核人</th>
              <th>申请时间</th>
              <th>影响范围</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in filteredRows"
              :key="row.changeId"
              :class="{ selected: row.changeId === selectedId }"
              @click="selectRow(row.changeId)"
            >
              <td><code>{{ row.changeId }}</code></td>
              <td>{{ row.title }}</td>
              <td>{{ row.type }}</td>
              <td>{{ displayNameOf(row.applicant) }}</td>
              <td>{{ displayNameOf(row.assignee) }}</td>
              <td>{{ row.time }}</td>
              <td>{{ row.scope }}</td>
              <td><span :class="['status-badge', row.status]">{{ statusText(row.status) }}</span></td>
              <td>
                <div class="audit-action-btns">
                  <template v-if="row.status === 'pending'">
                    <button v-if="activeScope === 'submitted'" class="btn btn-warning btn-small" :disabled="reviewLoading" @click.stop="withdrawChange(row.changeId)">撤回</button>
                    <template v-else>
                      <button class="btn btn-success btn-small" :disabled="!canReview(row) || reviewLoading" @click.stop="approveChange(row.changeId)">通过</button>
                      <button class="btn btn-danger btn-small" :disabled="!canReview(row) || reviewLoading" @click.stop="rejectChange(row.changeId)">驳回</button>
                      <span v-if="!canReview(row) && isMine(row.assignee) && isMine(row.applicant)" class="audit-self-review-hint" title="不能审核自己提交的变更">自查限制</span>
                    </template>
                  </template>
                  <button
                    v-else-if="row.status === 'approved' && canPublish(row)"
                    class="btn btn-primary btn-small"
                    title="审核已通过，点击发布生效"
                    :disabled="reviewLoading"
                    @click.stop="openPublishDialog(row.changeId)"
                  >发布</button>
                  <span v-else style="color: var(--text-tertiary); font-size: 12px;">—</span>
                </div>
              </td>
            </tr>
            <tr v-if="filteredRows.length === 0">
              <td colspan="9" style="text-align:center;color:var(--text-tertiary);padding:24px;">{{ emptyHint }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel mt-4">
      <div class="panel-header">
        <h3>变更详情：{{ selectedId }} ({{ selectedDetail.title }} / {{ selectedDetail.type }})</h3>
      </div>
      <div class="panel-body">
        <!-- 新格式：结构化对比视图 -->
        <template v-if="selectedDetail.diff && selectedDetail.diff.summary">
          <!-- 版本信息卡片 -->
          <div class="diff-version-cards">
            <div class="version-card old-card">
              <div class="version-card-label">修改前</div>
              <div class="version-card-title">{{ selectedDetail.diff.oldVersion.name }}</div>
              <div class="version-card-meta">
                版本 {{ selectedDetail.diff.oldVersion.version }}
                · 信号 {{ selectedDetail.diff.oldVersion.signalCount }}
                · 地址 {{ selectedDetail.diff.oldVersion.addressCount }}
              </div>
            </div>
            <div class="version-card new-card">
              <div class="version-card-label">修改后</div>
              <div class="version-card-title">{{ selectedDetail.diff.newVersion.name }}</div>
              <div class="version-card-meta">
                版本 {{ selectedDetail.diff.newVersion.version }}
                · 信号 {{ selectedDetail.diff.newVersion.signalCount }}
                · 地址 {{ selectedDetail.diff.newVersion.addressCount }}
              </div>
            </div>
          </div>

          <!-- 差异简述 -->
          <div class="diff-summary-panel">
            <div class="diff-section-title">差异简述</div>
            <ul class="diff-summary-items" v-if="selectedDetail.diff.summary.items.length">
              <li v-for="(item, i) in selectedDetail.diff.summary.items" :key="i" :class="'summary-' + item.type">
                {{ item.text }}
              </li>
            </ul>
            <div class="diff-summary-badges">
              <span class="diff-badge badge-delete" v-if="selectedDetail.diff.summary.deleted">删除 {{ selectedDetail.diff.summary.deleted }}</span>
              <span class="diff-badge badge-add" v-if="selectedDetail.diff.summary.added">新增 {{ selectedDetail.diff.summary.added }}</span>
              <span class="diff-badge badge-modify" v-if="selectedDetail.diff.summary.modified">变更 {{ selectedDetail.diff.summary.modified }}</span>
              <span class="diff-badge badge-unchanged" v-if="selectedDetail.diff.summary.unchanged">一致 {{ selectedDetail.diff.summary.unchanged }}</span>
            </div>
          </div>

          <!-- 协议属性变更 -->
          <div class="diff-meta-section" v-if="selectedDetail.diff.metaChanges.length">
            <div class="diff-section-title">协议属性变更</div>
            <div class="diff-meta-table">
              <div class="diff-meta-row" v-for="(m, i) in selectedDetail.diff.metaChanges" :key="i">
                <span class="diff-meta-field">{{ m.field }}</span>
                <span class="diff-meta-old">{{ m.old }}</span>
                <span class="diff-meta-arrow">→</span>
                <span class="diff-meta-new">{{ m.new }}</span>
              </div>
            </div>
          </div>

          <!-- 命令对比表 -->
          <div class="diff-cmd-section" v-if="selectedDetail.diff.commandRows.length">
            <div class="diff-section-title">命令对比</div>
            <table class="diff-cmd-table">
              <thead>
                <tr>
                  <th style="width:30px;">#</th>
                  <th>修改前</th>
                  <th style="width:56px;">状态</th>
                  <th>修改后</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in selectedDetail.diff.commandRows" :key="i" :class="'cmd-row-' + row.status">
                  <td class="cmd-idx">{{ i + 1 }}</td>
                  <td class="cmd-cell-old">
                    <template v-if="row.old">
                      <div class="cmd-line"><span class="cmd-code">{{ row.old.cmd }}</span><span class="cmd-name">{{ row.old.name }}</span></div>
                      <div class="cmd-sub">{{ row.old.sender }} → {{ row.old.receiver }} · {{ row.old.dir }} · 周期{{ row.old.cycle }}ms · {{ row.old.payloadLen }}B · {{ row.old.fieldCount }}字段</div>
                    </template>
                    <span v-else class="cmd-empty">—</span>
                  </td>
                  <td class="cmd-status-cell"><span class="cmd-status" :class="'status-' + row.status">{{ statusLabel(row.status) }}</span></td>
                  <td class="cmd-cell-new">
                    <template v-if="row.new">
                      <div class="cmd-line"><span class="cmd-code">{{ row.new.cmd }}</span><span class="cmd-name">{{ row.new.name }}</span></div>
                      <div class="cmd-sub">{{ row.new.sender }} → {{ row.new.receiver }} · {{ row.new.dir }} · 周期{{ row.new.cycle }}ms · {{ row.new.payloadLen }}B · {{ row.new.fieldCount }}字段</div>
                    </template>
                    <span v-else class="cmd-empty">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- 旧格式兼容：简单 diff 表 -->
        <div v-else class="diff-view">
          <div class="diff-header">
            <span>变更项</span>
            <span>修改前</span>
            <span>修改后</span>
          </div>
          <div class="diff-rows">
            <div class="diff-row" v-for="(d, i) in (Array.isArray(selectedDetail.diff) ? selectedDetail.diff : [])" :key="i" :class="'diff-type-' + (d.type || 'modify')">
              <div class="diff-field">{{ d.field || '—' }}</div>
              <div class="diff-old">{{ d.old || '—' }}</div>
              <div class="diff-new">{{ d.new || '—' }}</div>
            </div>
          </div>
        </div>

        <div v-if="selectedRow?.opinion" class="form-row mt-3">
          <label>审核意见</label>
          <div class="review-opinion">{{ selectedRow.opinion }}</div>
        </div>
      </div>
    </div>

    <!-- 审核通过确认弹窗 -->
    <Transition name="modal-fade">
      <div v-if="confirmDialog.show" class="modal-overlay" @click.self="confirmDialog.show = false">
        <div class="modal-dialog" style="max-width:420px;">
          <div class="modal-header">
            <h3>确认审核通过</h3>
          </div>
          <div class="modal-body">
            <p>确认通过协议「<b>{{ confirmDialog.title }}</b>」的变更申请？</p>
            <p v-if="confirmDialog.applicant" style="margin-top:8px;color:var(--text-secondary);">申请人：{{ confirmDialog.applicant }}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="confirmDialog.show = false">取消</button>
            <button class="btn btn-success" :disabled="reviewLoading" @click="doApprove">{{ reviewLoading ? '处理中…' : '确认通过' }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 发布生效确认弹窗 -->
    <Transition name="modal-fade">
      <div v-if="publishDialog.show" class="modal-overlay" @click.self="publishDialog.show = false">
        <div class="modal-dialog" style="max-width:420px;">
          <div class="modal-header">
            <h3>发布生效</h3>
          </div>
          <div class="modal-body">
            <p>将协议「<b>{{ publishDialog.title }}</b>」审核通过的变更发布生效？</p>
            <p style="margin-top:8px;color:var(--text-secondary);">发布后快照将写入正式协议内容与版本记录，对全队生效。</p>
            <p v-if="publishDialog.applicant" style="margin-top:8px;color:var(--text-secondary);">申请人：{{ publishDialog.applicant }}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="publishDialog.show = false">取消</button>
            <button class="btn btn-success" :disabled="reviewLoading" @click="doPublish">{{ reviewLoading ? '发布中…' : '确认发布' }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 驳回理由弹窗 -->
    <Transition name="modal-fade">
      <div v-if="rejectDialog.show" class="modal-overlay" @click.self="rejectDialog.show = false">
        <div class="modal-dialog" style="max-width:460px;">
          <div class="modal-header">
            <h3>驳回变更</h3>
          </div>
          <div class="modal-body">
            <p style="margin-bottom:10px;">请填写驳回理由（必填）：</p>
            <p style="margin-bottom:10px;color:var(--text-secondary);font-size:13px;">
              协议：<b>{{ rejectDialog.title }}</b>
            </p>
            <textarea
              ref="rejectTextarea"
              class="input"
              rows="4"
              v-model="rejectDialog.reason"
              placeholder="请输入驳回理由..."
              @keyup.enter.ctrl="doReject"
            ></textarea>
            <p v-if="rejectDialog.error" class="user-form-error" style="margin-top:8px;">{{ rejectDialog.error }}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="rejectDialog.show = false">取消</button>
            <button class="btn btn-danger" :disabled="reviewLoading" @click="doReject">{{ reviewLoading ? '处理中…' : '确认驳回' }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 撤回确认弹窗 -->
    <Transition name="modal-fade">
      <div v-if="withdrawDialog.show" class="modal-overlay" @click.self="withdrawDialog.show = false">
        <div class="modal-dialog" style="max-width:420px;">
          <div class="modal-header">
            <h3>确认撤回</h3>
          </div>
          <div class="modal-body">
            <p>确认撤回协议「<b>{{ withdrawDialog.title }}</b>」的变更申请？</p>
            <p style="margin-top:8px;color:var(--text-secondary);">撤回后该变更将不再进入审核流程。</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="withdrawDialog.show = false">取消</button>
            <button class="btn btn-warning" :disabled="reviewLoading" @click="doWithdraw">{{ reviewLoading ? '处理中…' : '确认撤回' }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useReviewQueue } from '../composables/useReviewQueue';
import { useCurrentUser } from '../composables/useCurrentUser';

/* ===================== 共享审核队列 ===================== */
const { reviewQueue, pendingCount, updateReviewStatus, publishReview, getReviewDetail, loadFromDatabase, isLoaded } = useReviewQueue();
const refreshing = ref(false);

/* 手动刷新列表 */
async function refreshList() {
  refreshing.value = true;
  try {
    await loadFromDatabase(true);
  } finally {
    refreshing.value = false;
  }
}

/* ===================== 当前用户 ===================== */
const { currentUser } = useCurrentUser();

/* ===================== Toast 提示 ===================== */
const toast = reactive({
  show: false,
  type: 'success',
  message: '',
  timer: null,
});

function showToast(message, type = 'success', duration = 2500) {
  if (toast.timer) clearTimeout(toast.timer);
  toast.message = message;
  toast.type = type;
  toast.show = true;
  toast.timer = setTimeout(() => { toast.show = false; }, duration);
}

/* ===================== Emit ===================== */
const emit = defineEmits(['pending-change']);

watch(pendingCount, (val) => emit('pending-change', val), { immediate: true });

/* ===================== 筛选 ===================== */
/* 视角切换：指派给我 / 我提交的 */
const scopeTabs = [
  { value: 'assigned', label: '指派给我' },
  { value: 'submitted', label: '我提交的' },
];

/* 状态筛选 */
const filterTabs = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' },
  { value: 'published', label: '已生效' },
  { value: 'withdrawn', label: '已撤回' },
  { value: 'all', label: '全部' },
];

const activeScope = ref('assigned');
const activeFilter = ref('pending');
const selectedId = ref('');
const reviewLoading = ref(false);

/* ===================== 确认弹窗 ===================== */
const confirmDialog = reactive({
  show: false,
  changeId: '',
  title: '',
  applicant: '',
});

/* 驳回弹窗 */
const rejectDialog = reactive({
  show: false,
  changeId: '',
  title: '',
  reason: '',
  error: '',
});
const rejectTextarea = ref(null);

/* 撤回弹窗 */
const withdrawDialog = reactive({
  show: false,
  changeId: '',
  title: '',
});

/* 发布生效弹窗 */
const publishDialog = reactive({
  show: false,
  changeId: '',
  title: '',
  applicant: '',
});

/* ===================== 计算属性 ===================== */
/* 当前用户全部身份（显示名/登录名/邮箱）：审核记录的 applicant 存登录名、
 * assignee 存显示名，任一字段匹配即视为本人，
 * 否则"我提交的"会因身份字段不一致而永远查不到自己的记录 */
const myIdentities = computed(() => {
  const u = currentUser.value || {};
  return new Set([u.name, u.username, u.email].filter(Boolean));
});

function isMine(value) {
  return !!value && myIdentities.value.has(value);
}

/* 登录名/邮箱 → 显示名映射（申请人、审核人列展示用） */
const userNameMap = ref({});

async function loadUserNameMap() {
  if (typeof window === 'undefined' || !window.electronAPI?.db) return;
  try {
    const result = await window.electronAPI.db.query('SELECT username, display_name, email FROM users');
    if (result.success && result.rows) {
      const map = {};
      for (const r of result.rows) {
        const display = r.display_name || r.username;
        if (r.username) map[r.username] = display;
        if (r.email) map[r.email] = display;
      }
      userNameMap.value = map;
    }
  } catch { /* 用户表不可用时直接展示原始值 */ }
}

function displayNameOf(id) {
  if (!id) return '—';
  return userNameMap.value[id] || id;
}

/**
 * 按视角 + 状态过滤
 */
const filteredRows = computed(() => {
  let items;
  if (activeScope.value === 'assigned') {
    items = reviewQueue.value.filter(r => isMine(r.assignee));
  } else {
    items = reviewQueue.value.filter(r => isMine(r.applicant));
  }
  if (activeFilter.value === 'all') return items;
  return items.filter(r => r.status === activeFilter.value);
});

/**
 * 当前选中行
 */
const selectedRow = computed(() =>
  reviewQueue.value.find(r => r.changeId === selectedId.value) || null,
);

const selectedDetail = computed(() => {
  const detail = getReviewDetail(selectedId.value);
  return { changeId: selectedId.value, ...detail };
});

/**
 * 是否可以审核（只有被指派人可以操作，且不能审核自己提交的）
 */
function canReview(row) {
  if (!row) return false;
  return isMine(row.assignee) && !isMine(row.applicant);
}

/**
 * 是否可以发布生效（审核通过的变更）：申请人、审核人或管理员
 */
function canPublish(row) {
  if (!row || row.status !== 'approved') return false;
  return isMine(row.applicant) || isMine(row.assignee) || !!currentUser.value?.isAdmin;
}

/**
 * 空列表提示：按视角 + 筛选给出原因，避免"看起来像坏了"
 */
const emptyHint = computed(() => {
  if (activeScope.value === 'assigned' && activeFilter.value === 'pending') {
    return '暂无待你审核的变更——他人提交并指派你审核后，列表会在 10 秒内自动出现';
  }
  if (activeScope.value === 'submitted' && activeFilter.value === 'pending') {
    return '暂无你提交且待审核的变更；可在「协议配置」页对协议点「提交审核」';
  }
  const filterText = { pending: '待审核', approved: '已通过', rejected: '已驳回', published: '已生效', withdrawn: '已撤回', all: '' }[activeFilter.value] || '';
  return filterText ? `暂无${filterText}的审核记录` : '暂无相关审核记录';
});

/**
 * 提取可读错误信息：服务端校验失败时把真实原因透出给用户（否则无法排查）
 */
function errText(e, fallback) {
  const msg = e && e.message ? String(e.message) : '';
  return msg || fallback;
}

/* ===================== 操作函数 ===================== */

function selectRow(id) {
  selectedId.value = id;
}

function statusText(status) {
  return { pending: '待审核', approved: '已通过', rejected: '已驳回', published: '已生效', withdrawn: '已撤回' }[status] || status;
}

function statusLabel(status) {
  return { added: '新增', deleted: '删除', modified: '变更', unchanged: '一致' }[status] || status;
}

function approveChange(id) {
  const row = reviewQueue.value.find(r => r.changeId === id);
  if (!row) return;
  if (!canReview(row)) {
    showToast('您无权审核此变更（不能审核自己提交的变更）', 'error');
    return;
  }
  confirmDialog.changeId = id;
  confirmDialog.title = row.title;
  confirmDialog.applicant = displayNameOf(row.applicant);
  confirmDialog.show = true;
}

async function doApprove() {
  const id = confirmDialog.changeId;
  if (!id) return;
  reviewLoading.value = true;
  try {
    await updateReviewStatus(id, 'approved', '');
    showToast('审核通过', 'success');
  } catch (e) {
    console.error('[审核] 通过失败:', e);
    showToast(errText(e, '审核操作失败，请重试'), 'error', 4000);
  } finally {
    reviewLoading.value = false;
    confirmDialog.show = false;
  }
}

function rejectChange(id) {
  const row = reviewQueue.value.find(r => r.changeId === id);
  if (!row) return;
  if (!canReview(row)) {
    showToast('您无权审核此变更（不能审核自己提交的变更）', 'error');
    return;
  }
  /* 打开驳回弹窗，用户填理由后确认 */
  rejectDialog.changeId = id;
  rejectDialog.title = row.title;
  rejectDialog.reason = '';
  rejectDialog.error = '';
  rejectDialog.show = true;
  /* 弹窗打开后自动聚焦输入框 */
  setTimeout(() => {
    if (rejectTextarea.value) {
      rejectTextarea.value.focus();
    }
  }, 100);
}

async function doReject() {
  const reason = rejectDialog.reason.trim();
  if (!reason) {
    rejectDialog.error = '请输入驳回理由';
    return;
  }
  reviewLoading.value = true;
  try {
    await updateReviewStatus(rejectDialog.changeId, 'rejected', reason);
    showToast('已驳回', 'success');
    rejectDialog.show = false;
  } catch (e) {
    console.error('[审核] 驳回失败:', e);
    showToast(errText(e, '驳回操作失败，请重试'), 'error', 4000);
  } finally {
    reviewLoading.value = false;
  }
}

function withdrawChange(id) {
  const row = reviewQueue.value.find(r => r.changeId === id);
  if (!row) return;
  withdrawDialog.changeId = id;
  withdrawDialog.title = row.title;
  withdrawDialog.show = true;
}

async function doWithdraw() {
  const id = withdrawDialog.changeId;
  if (!id) return;
  reviewLoading.value = true;
  try {
    await updateReviewStatus(id, 'withdrawn', '申请人撤回');
    showToast('已撤回', 'success');
  } catch (e) {
    console.error('[审核] 撤回失败:', e);
    showToast(errText(e, '撤回操作失败，请重试'), 'error', 4000);
  } finally {
    reviewLoading.value = false;
    withdrawDialog.show = false;
  }
}

function openPublishDialog(id) {
  const row = reviewQueue.value.find(r => r.changeId === id);
  if (!row) return;
  if (!canPublish(row)) {
    showToast('仅申请人、审核人或管理员可以发布生效', 'error');
    return;
  }
  publishDialog.changeId = id;
  publishDialog.title = row.title;
  publishDialog.applicant = displayNameOf(row.applicant);
  publishDialog.show = true;
}

async function doPublish() {
  const id = publishDialog.changeId;
  if (!id) return;
  reviewLoading.value = true;
  try {
    await publishReview(id);
    showToast('已发布生效', 'success');
    publishDialog.show = false;
  } catch (e) {
    console.error('[审核] 发布失败:', e);
    showToast(errText(e, '发布生效失败，请重试'), 'error', 4000);
  } finally {
    reviewLoading.value = false;
  }
}

/* ===================== 导出审计日志 ===================== */
async function exportAuditLog() {
  if (reviewQueue.value.length === 0) {
    showToast('暂无审计记录可导出', 'error');
    return;
  }
  const header = ['变更单号', '协议名称', '变更类型', '申请人', '审核人', '申请时间', '影响范围', '状态', '审核意见'];
  const statusMap = { pending: '待审核', approved: '已通过', rejected: '已驳回', published: '已生效', withdrawn: '已撤回' };
  const rows = reviewQueue.value.map(r => [
    r.changeId, r.title, r.type, displayNameOf(r.applicant), displayNameOf(r.assignee), r.time, r.scope,
    statusMap[r.status] || r.status, (r.opinion || '').replace(/[\n\r]/g, ' '),
  ]);
  const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `审计日志_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${rows.length} 条审计记录`, 'success');
}

/* ===================== 生命周期 ===================== */
onMounted(async () => {
  /* 每次进入页面都从数据库刷新，确保看到最新数据（多人协作场景） */
  await loadFromDatabase(true);
  loadUserNameMap();
  /* 选中第一行 */
  if (filteredRows.value.length > 0) {
    selectedId.value = filteredRows.value[0].changeId;
  }
});
</script>
