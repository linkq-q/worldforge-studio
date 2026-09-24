import './styles.css';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app root');
void import('./client/mapEditor').then(({ startMapEditor }) => startMapEditor(app));
