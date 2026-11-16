import '@fontsource-variable/inter';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles/main.css';
import { App } from './app.js';

function boot() {
  try {
    window.__pyrosonic = new App();
  } catch (err) {
    console.error(err);
    const el = document.createElement('div');
    el.className = 'fatal';
    el.innerHTML = '<div><h2>Something went wrong</h2><p>Pyrosonic could not start in this browser. Please try a recent version of Chrome, Edge, Firefox or Safari.</p></div>';
    document.body.appendChild(el);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
