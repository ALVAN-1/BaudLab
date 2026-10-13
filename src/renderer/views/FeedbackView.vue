<template>
  <div class="view-pad feedback-view">
    <div class="view-header">
      <h2>反馈问题</h2>
      <div class="view-header-actions">
        <span :class="['status-chip', tokenConfigured ? 'ok' : 'warn']" style="margin-right:8px;">
          {{ tokenConfigured ? '✅ Token 已配置 · 直接提交' : '⚠️ 未配置 Token · 跳转网页' }}
        </span>
        <button class="feedback-browse" @click="browseIssues">浏览已有 Issue</button>
      </div>
    </div>

    <div class="panel feedback-panel">
      <div class="panel-body">
        <div class="feedback-intro">
          <p v-if="tokenConfigured">配置了 GitHub Token，下面提交将自动写入仓库 Issue，不需要手动粘贴。</p>
          <p v-else>还未配置 GitHub 令牌，提交时会跳转网页手动填写。<a class="about-link" @click="goSettings">前往系统设置配置 →</a></p>
        </div>

        <div class="feedback-form">
          <div class="form-row">
            <label class="form-label">类型 <span class="required">*</span></label>
            <select v-model="form.type" class="form-input">
              <option value="bug">🐛 Bug 报告</option>
              <option value="feature">✨ 功能建议</option>
              <option value="question">❓ 使用疑问</option>
            </select>
          </div>

          <div class="form-row">
            <label class="form-label">标题 <span class="required">*</span></label>
            <input
              v-model="form.title"
              class="form-input"
              placeholder="简短描述问题或建议"
              maxlength="100"
            />
          </div>

          <div class="form-row">
            <label class="form-label">详细描述 <span class="required">*</span></label>
            <textarea
              v-model="form.description"
              class="form-textarea"
              placeholder="请详细描述：&#10;- 复现步骤（如果是 Bug）&#10;- 期望结果与实际结果&#10;- 环境信息（操作系统、版本等）"
              rows="8"
            ></textarea>
          </div>

          <div class="form-row">
            <label class="form-label">优先级</label>
            <select v-model="form.priority" class="form-input">
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </div>

          <p v-if="formError" class="form-error">{{ formError }}</p>

          <!-- 提交成功 -->
          <div v-if="submitSuccess" class="submit-result ok">
            <div class="submit-result-title">✅ 提交成功</div>
            <div class="submit-result-info">
              <div class="submit-result-line"><span>Issue 编号：</span><strong>#{{ issueNumber }}</strong></div>
              <div class="submit-result-line"><span>链接：</span><a class="about-link" @click="openIssueUrl">{{ issueUrl }}</a></div>
            </div>
            <button class="btn btn-secondary btn-small" @click="openIssueUrl">在浏览器中打开</button>
          </div>

          <!-- 提交失败时降级处理 -->
          <div v-if="submitFallback" class="submit-result warn">
            <div class="submit-result-title">⚠️ 直接提交失败，已回退到网页提交</div>
            <div class="submit-result-info">
              <div class="submit-result-line">原因：{{ submitFallback }}</div>
              <div class="submit-result-line">GitHub 新建 Issue 页面已打开，标题预填充，请手动粘贴描述并提交。</div>
            </div>
            <p class="form-success" style="margin-top:8px;">内容已复制到剪贴板，粘贴即可。</p>
          </div>

          <div class="form-actions">
            <button class="btn btn-secondary" @click="resetForm">重置</button>
            <button class="btn btn-primary" :disabled="submitting" @click="submit">
              {{ submitting ? '提交中...' : (tokenConfigured ? '直接提交到 GitHub' : '跳转网页提交') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { useGithubToken } from '../composables/useGithubToken';

const { configured: tokenConfigured, ensureMigrated } = useGithubToken();

const form = reactive({
  type: 'bug',
  title: '',
  description: '',
  priority: 'medium',
});

const formError = ref('');
const submitting = ref(false);
const submitSuccess = ref(false);
const submitFallback = ref('');
const issueNumber = ref(null);
const issueUrl = ref('');

onMounted(() => { ensureMigrated(); });

const typeLabels = { bug: 'Bug', feature: '功能建议', question: '疑问' };
const priorityLabels = { low: '低', medium: '中', high: '高' };

async function submit() {
  formError.value = '';
  submitSuccess.value = false;
  submitFallback.value = '';
  issueNumber.value = null;
  issueUrl.value = '';

  if (!form.title.trim()) { formError.value = '请输入标题'; return; }
  if (!form.description.trim()) { formError.value = '请输入详细描述'; return; }

  submitting.value = true;
  try {
    // 优先：直接走后端 GitHub API 提交（token 由主进程提供，渲染层不再持有）
    if (tokenConfigured.value && window.electronAPI?.feedback?.submitIssue) {
      const res = await window.electronAPI.feedback.submitIssue({
        title: form.title,
        description: form.description,
        type: form.type,
        priority: form.priority,
      });
      if (res.success) {
        issueNumber.value = res.issueNumber || '?';
        issueUrl.value = res.htmlUrl || '';
        submitSuccess.value = true;
        submitting.value = false;
        return;
      } else {
        // 失败：降级到网页
        submitFallback.value = res.error || '未知错误';
      }
    }

    // 降级：打开网页 + 剪贴板
    await fallbackSubmit();
    if (!submitFallback.value) {
      // fallback 正常没出错，只算作网页方式提交成功（没 token 时的正常路径）
      submitSuccess.value = false; // 不要显示成功卡片
    }
  } catch (e) {
    formError.value = '提交失败：' + (e.message || e);
  } finally {
    submitting.value = false;
  }
}

async function fallbackSubmit() {
  const body = [
    `**类型**: ${typeLabels[form.type]}`,
    `**优先级**: ${priorityLabels[form.priority]}`,
    '',
    '### 描述',
    form.description,
    '',
    `---`,
    `_由 Serial Protocol Manager 反馈功能自动生成_`,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(body);
  } catch { /* ignore */ }

  const titleParam = encodeURIComponent(`[${typeLabels[form.type]}] ${form.title}`);
  const githubUrl = `https://github.com/ALVAN-1/BaudLab.io/issues/new?title=${titleParam}`;

  if (window.electronAPI?.shell?.openExternal) {
    await window.electronAPI.shell.openExternal(githubUrl);
  }
}

function resetForm() {
  form.type = 'bug';
  form.title = '';
  form.description = '';
  form.priority = 'medium';
  formError.value = '';
  submitSuccess.value = false;
  submitFallback.value = '';
  issueNumber.value = null;
  issueUrl.value = '';
}

function browseIssues() {
  if (window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal('https://github.com/ALVAN-1/BaudLab.io/issues');
  }
}

function goSettings() {
  // 通过自定义事件通知 App.vue 切视图
  window.dispatchEvent(new CustomEvent('spm-switch-view', { detail: 'settings' }));
}

function openIssueUrl() {
  if (!issueUrl.value) return;
  if (window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal(issueUrl.value);
  }
}
</script>

<style scoped>
.feedback-view { display: flex; flex-direction: column; height: 100%; gap: 16px; }
.view-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.view-header h2 { font-size: 18px; font-weight: 600; margin: 0; }
.view-header-actions { display: flex; align-items: center; }
.feedback-browse {
  padding: 4px 12px; border-radius: 6px; font-size: 13px;
  border: 1px solid var(--border-light); background: var(--bg-secondary); color: var(--accent-blue);
  cursor: pointer;
}
.feedback-browse:hover { border-color: var(--accent-blue); }

.feedback-panel { flex: 1; overflow-y: auto; }
.feedback-intro p { font-size: 14px; color: var(--text-tertiary); margin: 0 0 20px; line-height: 1.6; }

.feedback-form { display: flex; flex-direction: column; gap: 16px; }
.form-row { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.required { color: var(--accent-red); }
.form-input {
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px;
  padding: 8px 12px; font-size: 14px; color: var(--text-primary); outline: none;
}
.form-input:focus { border-color: var(--accent-blue); }
.form-textarea {
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px;
  padding: 10px 12px; font-size: 14px; color: var(--text-primary); outline: none;
  resize: vertical; min-height: 120px; font-family: inherit; line-height: 1.5;
}
.form-textarea:focus { border-color: var(--accent-blue); }

.form-error { color: var(--accent-red); font-size: 13px; margin: 0; }
.form-success { color: var(--accent-green); font-size: 13px; margin: 0; }

.status-chip {
  padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 500;
}
.status-chip.ok { background: rgba(16, 185, 129, 0.12); color: var(--accent-green); }
.status-chip.warn { background: rgba(245, 158, 11, 0.12); color: var(--accent-amber); }

.submit-result {
  border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px;
}
.submit-result.ok { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); }
.submit-result.warn { background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); }
.submit-result-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.submit-result-info { display: flex; flex-direction: column; gap: 4px; }
.submit-result-line { font-size: 13px; color: var(--text-secondary); word-break: break-all; }
.submit-result-line strong { color: var(--text-primary); }

.about-link { color: var(--accent-blue); cursor: pointer; text-decoration: none; }
.about-link:hover { text-decoration: underline; }

.form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
</style>
