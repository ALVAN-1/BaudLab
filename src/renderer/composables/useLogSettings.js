import { ref } from 'vue';

const STORAGE_KEY = 'spm-show-newline';

/* 默认隐藏换行符 */
const showNewline = ref(localStorage.getItem(STORAGE_KEY) === 'true');

export function useLogSettings() {
  function setShowNewline(val) {
    showNewline.value = !!val;
    localStorage.setItem(STORAGE_KEY, String(showNewline.value));
  }

  function toggleShowNewline() {
    setShowNewline(!showNewline.value);
  }

  return { showNewline, setShowNewline, toggleShowNewline };
}
