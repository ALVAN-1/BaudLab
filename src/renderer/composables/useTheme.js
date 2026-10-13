import { ref, onMounted } from 'vue';

const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';

const currentTheme = ref('dark');
const isDark = ref(true);

export function useTheme() {
  function applyTheme(theme) {
    if (theme === 'system') theme = 'dark';
    const dark = theme === 'dark';
    isDark.value = dark;
    document.body.classList.toggle('light', !dark);
    localStorage.setItem('spm-theme', theme);
    currentTheme.value = theme;
    if (hasElectron) {
      window.electronAPI.theme.set(theme);
    }
  }

  function setTheme(theme) {
    applyTheme(theme);
  }

  onMounted(() => {
    const saved = localStorage.getItem('spm-theme') || 'dark';
    applyTheme(saved);
  });

  return {
    currentTheme,
    isDark,
    setTheme,
  };
}
