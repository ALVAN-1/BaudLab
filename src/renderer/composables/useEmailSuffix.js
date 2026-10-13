import { computed, reactive, ref } from 'vue';

/* 常用邮箱后缀，按国内使用频率排序 */
export const COMMON_EMAIL_DOMAINS = [
  'qq.com',
  '163.com',
  '126.com',
  'foxmail.com',
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'sina.com',
  '139.com',
  'yeah.net',
  'aliyun.com',
];

/* 一次最多展示的后缀条数 */
const MAX_SUGGESTIONS = 6;
/* 候选项高度估算（含列表内边距与边框），用于向上/向下弹出方向判断 */
const ITEM_HEIGHT = 32;
const POPUP_CHROME = 10;

/**
 * 根据输入值计算后缀候选（纯函数）
 * 规则：@ 后无内容 → 全量候选；@ 后按前缀过滤；与某后缀完全一致 → 视为已补全不再提示
 * @param {string} value 输入框当前值
 * @param {string[]} domains 候选后缀列表
 * @returns {Array<{domain: string, local: string, typed: string}>}
 */
export function computeEmailSuggestions(value, domains = COMMON_EMAIL_DOMAINS) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at < 1) return [];
  const local = text.slice(0, at);
  const typed = text.slice(at + 1).toLowerCase();
  if (typed.includes('@')) return []; // 出现第二个 @，非法输入
  if (!typed) {
    return domains.slice(0, MAX_SUGGESTIONS).map((domain) => ({ domain, local, typed: '' }));
  }
  return domains
    .filter((d) => d !== typed && d.startsWith(typed))
    .slice(0, MAX_SUGGESTIONS)
    .map((domain) => ({ domain, local, typed }));
}

/**
 * 邮箱后缀自动补全：输入 @ 后弹出常用后缀下拉
 * 键盘 ↑↓ 移动高亮、Enter 选中（并吞掉本次回车的表单提交）、Esc 关闭；点击候选项回填
 * 下拉 Teleport 到 body 固定定位，不受登录弹窗 overflow:hidden 裁剪，下方空间不足时自动向上弹出
 *
 * @param {() => string} getValue 读取输入框当前值
 * @param {(v: string) => void} setValue 回填完整邮箱
 * @param {() => HTMLElement|null} getEl 取输入框元素（用于定位）
 */
export function useEmailSuffix(getValue, setValue, getEl) {
  /* 用户主动关闭（Esc/选中/失焦）后，再次输入时重新打开 */
  const dismissed = ref(true);
  const activeIndex = ref(0);
  /* 本次回车已用于选中后缀，对应的 keyup.enter 不应再触发表单提交 */
  let enterConsumed = false;

  const suggestions = computed(() => computeEmailSuggestions(getValue()));
  const open = computed(() => !dismissed.value && suggestions.value.length > 0);

  /* 跟随输入框位置；登录弹窗为固定尺寸静态布局，弹层打开期间无需追踪滚动/缩放 */
  const popStyle = computed(() => {
    if (!open.value) return {};
    const el = getEl && getEl();
    if (!el || typeof el.getBoundingClientRect !== 'function') return {};
    const rect = el.getBoundingClientRect();
    const estimated = suggestions.value.length * ITEM_HEIGHT + POPUP_CHROME;
    const style = { left: rect.left + 'px', width: rect.width + 'px' };
    if (rect.bottom + 4 + estimated > window.innerHeight && rect.top - 4 - estimated > 0) {
      style.bottom = window.innerHeight - rect.top + 4 + 'px';
    } else {
      style.top = rect.bottom + 4 + 'px';
    }
    return style;
  });

  function onInput() {
    dismissed.value = false;
    activeIndex.value = 0;
  }

  function dismiss() {
    dismissed.value = true;
  }

  function select(index) {
    const item = suggestions.value[index];
    if (!item) return;
    setValue(`${item.local}@${item.domain}`);
    dismissed.value = true;
  }

  /** 返回 true 表示按键已被弹层消费（模板里仍绑定原生 @keydown，无需修饰符） */
  function onKeydown(e) {
    if (!open.value) return false;
    const count = suggestions.value.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      activeIndex.value = (activeIndex.value + delta + count) % count;
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      enterConsumed = true;
      select(activeIndex.value);
      return true;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismissed.value = true;
      return true;
    }
    return false;
  }

  /** 绑定在 @keyup.enter 的处理器里先调用：返回 true 时跳过本次表单提交 */
  function shouldSkipEnter() {
    const skip = enterConsumed;
    enterConsumed = false;
    return skip;
  }

  return reactive({
    open,
    activeIndex,
    suggestions,
    popStyle,
    onInput,
    dismiss,
    select,
    onKeydown,
    shouldSkipEnter,
  });
}
