import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import iconUrl from './assets/icon.svg';
import spriteUrl from './assets/sprite.svg';

fetch(spriteUrl)
  .then(r => r.text())
  .then(svg => {
    const div = document.createElement('div');
    div.style.display = 'none';
    div.innerHTML = svg;
    document.body.insertBefore(div, document.body.firstChild);
  });

createApp(App).mount('#app');
