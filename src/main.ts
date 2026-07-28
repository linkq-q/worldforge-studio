import './styles.css';
import { startMapEditor } from './client/mapEditor';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app root');

startMapEditor(app);
