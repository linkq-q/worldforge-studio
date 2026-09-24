import './experimentWorkspace.css';
import { serverHttpBase } from './serverEndpoint';
import { type EditableMap, type MapSummary } from '../shared/map';
import { CHAT_PROVIDER_OPTIONS, MODEL_PROVIDERS } from '../shared/protocol';
import { MODEL_GENERATION_MODES } from '../shared/modelGenerationMode';
import {
  EXPERIMENT_API_PROFILES, REVIEW_TAGS,
  type MapCatalog, type Experiment, type ExperimentConfig, type ExperimentRun, type ExperimentReview
} from '../shared/experiments';
import { createMapViewer, type MapViewer } from './mapViewer';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]!);
const statusNames: Record<string, string> = { draft:'待开始', running:'运行中', paused:'已暂停', completed:'已完成', partial:'部分资产失败', queued:'排队中', failed:'失败', interrupted:'已中断', cancelled:'已取消' };
const templates = { repeat:'同条件重复生成', assets:'同规划 · 资产模型对照', prompts:'提示词对照', apis:'API 对照' };
const ratingNames = { '':'未评价', good:'好 / 满足', fair:'一般 / 部分满足', poor:'差 / 不满足', unknown:'无法判断' };
async function api<T>(url: string, data?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(serverHttpBase(location, import.meta.env.DEV) + '/api/editor/' + url, {
    method: data === undefined ? 'GET' : method,
    headers: { 'Content-Type':'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  return value as T;
}
export class ExperimentWorkspace {
  private catalog: MapCatalog = { folders:[], membership:{} };
  private maps: MapSummary[] = [];
  private jobs: Experiment[] = [];
  private folder = 'unfiled';
  private view: 'maps' | 'experiments' = 'maps';
  private visible = true;
  private jobId = '';
  private selected = new Set<string>();
  private search = '';
  private reviewRun = '';
  private reviewFilter = 'all';
  private blind = true;
  private viewers: Array<{ viewer: MapViewer; controls: OrbitControls; observer: ResizeObserver }> = [];
  private previewVersion = 0;
  constructor(private readonly app: HTMLElement, private readonly callbacks: {
    openMap: (id: string) => Promise<boolean>;
    catalogChanged: (catalog: MapCatalog, maps: MapSummary[]) => void;
  }) {
    this.app.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-open-map]');
      if (button) this.action(async () => {
        button.setAttribute('disabled', '');
        try {
          if (await this.callbacks.openMap(button.dataset.openMap!)) this.notice('已在上方编辑器显示地图，可直接查看和编辑。');
        } finally { button.removeAttribute('disabled'); }
      });
    });
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const { viewer } of this.viewers) { if (visible) viewer.start(); else viewer.stop(); }
  }
  open(view: 'maps' | 'experiments'): void {
    this.setVisible(true);
    if (view !== this.view) { this.view = view; this.reviewRun = ''; this.render(); }
  }
  async start(): Promise<void> {
    this.app.className = 'lab lab-embedded';
    this.app.innerHTML = '<div class="empty">正在读取地图与实验…</div>';
    await this.reload();
    this.render();
    window.setInterval(() => {
      if (this.visible && this.view === 'experiments' && !this.reviewRun && !this.app.querySelector('#experiment-form')) {
        void this.refreshJobs().catch(error => this.notice(String(error), true));
      }
    }, 3000);
  }
  private async reload(): Promise<void> {
    const [catalog, maps, jobs] = await Promise.all([
      api<MapCatalog>('map-folders'), api<{ maps: MapSummary[] }>('maps'), api<{ experiments: Experiment[] }>('experiments')
    ]);
    this.catalog = catalog; this.maps = maps.maps; this.jobs = jobs.experiments;
    this.callbacks.catalogChanged(this.catalog, this.maps);
  }
  private notice(message: string, error = false): void {
    const node = this.app.querySelector('#lab-notice');
    if (node) { node.textContent = message; node.classList.toggle('error', error); }
  }
  private action(work: () => Promise<void>): void { void work().catch(error => this.notice(error instanceof Error ? error.message : String(error), true)); }
  private folderPath(id: string): string {
    const folder = this.catalog.folders.find(folder => folder.id === id);
    return folder ? (folder.parentId ? this.folderPath(folder.parentId) + ' / ' : '') + folder.name : '未归档';
  }
  private options(selected = '', unfiled = true): string {
    return (unfiled ? '<option value="">未归档</option>' : '<option value="">请选择文件夹</option>')
      + this.catalog.folders.map(folder => '<option value="' + folder.id + '" ' + (folder.id === selected ? 'selected' : '') + '>' + escape(this.folderPath(folder.id)) + '</option>').join('');
  }
  private dispose(): void {
    this.previewVersion++;
    for (const item of this.viewers) { item.observer.disconnect(); item.controls.dispose(); item.viewer.dispose(); }
    this.viewers = [];
  }
  private render(): void {
    this.dispose();
    this.app.innerHTML = '<header class="lab-header"><div><h1>地图库与实验</h1></div><nav><button data-view="maps">地图库</button><button data-view="experiments">生成实验</button></nav></header><div id="lab-notice" class="notice" role="status"></div><div class="layout"><aside class="lab-sidebar"><h3>地图文件夹</h3><div id="folders"></div><button id="new-folder">＋ 新建文件夹</button><button id="rename-folder">重命名</button></aside><main class="content" id="lab-content"></main></div>';
    const folders = this.app.querySelector('#folders')!;
    folders.innerHTML = [{ id:'all', name:'全部地图' }, { id:'unfiled', name:'未归档' }, ...this.catalog.folders.map(folder => ({ ...folder, name:this.folderPath(folder.id) }))]
      .map(folder => '<button class="folder ' + (this.folder === folder.id ? 'active' : '') + '" data-folder="' + folder.id + '">' + escape(folder.name) + '<span>' + this.maps.filter(map => folder.id === 'all' || (this.catalog.membership[map.id] ?? 'unfiled') === folder.id).length + '</span></button>').join('');
    this.app.querySelectorAll<HTMLElement>('[data-view]').forEach(button => {
      button.classList.toggle('active', button.dataset.view === this.view);
      button.onclick = () => { this.view = button.dataset.view as 'maps' | 'experiments'; this.reviewRun = ''; this.render(); };
    });
    this.app.querySelectorAll<HTMLElement>('[data-folder]').forEach(button => button.onclick = () => {
      this.folder = button.dataset.folder!; this.view = 'maps'; this.selected.clear(); this.reviewRun = ''; this.render();
    });
    this.app.querySelector<HTMLElement>('#new-folder')!.onclick = () => this.folderDialog();
    this.app.querySelector<HTMLElement>('#rename-folder')!.onclick = () => this.folderDialog(this.folder);
    if (this.view === 'maps') this.renderMaps(); else this.renderExperiments();
  }
  private folderDialog(id?: string): void {
    const current = this.catalog.folders.find(folder => folder.id === id);
    if (id && !current) { this.notice('请先选择一个文件夹。'); return; }
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<form id="folder-form"><h2>' + (current ? '编辑文件夹' : '新建文件夹') + '</h2><label class="field">名称<input name="name" required maxlength="80" value="' + escape(current?.name ?? '') + '"></label><label class="field">上级文件夹<select name="parent">' + '<option value="">顶层</option>' + this.catalog.folders.filter(folder => folder.id !== id).map(folder => '<option value="' + folder.id + '" ' + (folder.id === (current?.parentId ?? (this.catalog.folders.some(f => f.id === this.folder) ? this.folder : '')) ? 'selected' : '') + '>' + escape(this.folderPath(folder.id)) + '</option>').join('') + '</select></label><p id="folder-error"></p><div class="row"><button class="primary" type="submit">保存</button><button type="button" id="folder-cancel">取消</button></div></form>';
    this.app.append(dialog); dialog.showModal();
    dialog.querySelector('#folder-cancel')!.addEventListener('click', () => dialog.remove());
    dialog.querySelector('form')!.onsubmit = event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      void api<{ folder:{ id:string } }>('map-folders', { ...(current ? { id } : {}), name:form.get('name'), parentId:form.get('parent') || null })
        .then(async result => { this.folder = result.folder.id; await this.reload(); dialog.remove(); this.render(); })
        .catch(error => { dialog.querySelector('#folder-error')!.textContent = error.message; });
    };
  }
  private renderMaps(): void {
    const content = this.app.querySelector('#lab-content')!;
    const name = this.folder === 'all' ? '全部地图' : this.folderPath(this.folder);
    content.innerHTML = '<h2>' + escape(name) + '</h2><p>批量选中旧地图，移入文件夹即可归档。移动只改变归属，不改地图内容与撤销记录。</p><div class="row"><input id="map-search" placeholder="搜索地图名称" aria-label="搜索地图名称" value="' + escape(this.search) + '"><span class="spacer"></span><select id="move-folder" aria-label="目标文件夹">' + this.options(this.folder) + '</select><button id="move-maps" class="primary">移动选中地图</button><button id="refresh-maps">刷新</button></div><div class="panel table-wrap"><table><thead><tr><th><input id="select-all" type="checkbox" aria-label="全选当前列表"></th><th>地图</th><th>所在文件夹</th><th>对象</th><th>更新时间</th><th></th></tr></thead><tbody id="map-rows"></tbody></table><p id="map-count" class="muted"></p></div>';
    this.renderMapRows();
    content.querySelector<HTMLInputElement>('#map-search')!.oninput = event => { this.search = (event.target as HTMLInputElement).value; this.renderMapRows(); };
    content.querySelector<HTMLInputElement>('#select-all')!.onchange = event => {
      for (const map of this.filteredMaps()) { if ((event.target as HTMLInputElement).checked) this.selected.add(map.id); else this.selected.delete(map.id); }
      this.renderMapRows();
    };
    content.querySelector<HTMLElement>('#move-maps')!.onclick = () => this.action(async () => {
      if (!this.selected.size) { this.notice('请先选中地图。'); return; }
      this.catalog = await api<MapCatalog>('map-folders/move', { mapIds:[...this.selected], folderId:(content.querySelector('#move-folder') as HTMLSelectElement).value || null });
      this.callbacks.catalogChanged(this.catalog, this.maps);
      const count = this.selected.size; this.selected.clear(); this.render(); this.notice('已移动 ' + count + ' 张地图。');
    });
    content.querySelector<HTMLElement>('#refresh-maps')!.onclick = () => this.action(async () => { await this.reload(); this.render(); });
  }
  private filteredMaps(): MapSummary[] {
    return this.maps.filter(map => (this.folder === 'all' || (this.catalog.membership[map.id] ?? 'unfiled') === this.folder) && map.name.toLocaleLowerCase().includes(this.search.toLocaleLowerCase()));
  }
  private renderMapRows(): void {
    const maps = this.filteredMaps();
    this.app.querySelector('#map-rows')!.innerHTML = maps.map(map => '<tr><td><input type="checkbox" data-map="' + map.id + '" aria-label="选择 ' + escape(map.name) + '" ' + (this.selected.has(map.id) ? 'checked' : '') + '></td><td>' + escape(map.name) + '<small>' + map.width + ' × ' + map.depth + ' · ' + escape(map.assetGenerationMode) + '</small></td><td>' + escape(this.folderPath(this.catalog.membership[map.id])) + '</td><td>' + map.objectCount + '</td><td>' + new Date(map.updatedAt).toLocaleString() + '</td><td><button data-open-map="' + map.id + '">查看地图</button></td></tr>').join('');
    this.app.querySelector('#map-count')!.textContent = maps.length + ' 张地图 · 已选 ' + this.selected.size;
    this.app.querySelectorAll<HTMLInputElement>('[data-map]').forEach(input => input.onchange = () => {
      if (input.checked) this.selected.add(input.dataset.map!); else this.selected.delete(input.dataset.map!); this.renderMapRows();
    });
  }
  private renderExperiments(): void {
    const content = this.app.querySelector('#lab-content')!;
    content.innerHTML = '<div class="row"><h2>生成实验</h2><span class="spacer"></span><button id="create-experiment" class="primary">＋ 新建实验</button></div><p>先配置对照条件，再批量运行。结果自动归入指定文件夹，人工评价与 Agent 初评分开保存。</p><div class="row"><select id="experiment-select" aria-label="选择实验"><option value="">选择实验</option>' + this.jobs.map(job => '<option value="' + job.id + '" ' + (job.id === this.jobId ? 'selected' : '') + '>' + escape(job.config.name) + ' · ' + statusNames[job.status] + '</option>').join('') + '</select></div><div id="experiment-detail"></div>';
    content.querySelector<HTMLElement>('#create-experiment')!.onclick = () => this.experimentForm();
    content.querySelector<HTMLSelectElement>('#experiment-select')!.onchange = event => {
      this.jobId = (event.target as HTMLSelectElement).value; this.reviewRun = ''; this.renderJob();
    };
    this.renderJob();
  }
  private experimentForm(config?: ExperimentConfig): void {
    this.dispose(); this.reviewRun = '';
    const content = this.app.querySelector('#experiment-detail')!;
    const value = config ?? { name:'', question:'', folderId:this.catalog.folders.some(f => f.id === this.folder) ? this.folder : '', template:'assets', repeats:3, assetRepeats:1, minNewAssets:10, maxNewAssets:16, size:[96,20,96], sceneMode:'outdoor', assetGenerationMode:'voxel', provider:'gpt', assetProviders:['gpt','deepseek'], revisionMode:'first-pass', spatialPolicy:'diagnose', promptMode:'standard', cases:[] };
    content.innerHTML = '<form id="experiment-form" class="panel"><h3>实验条件</h3><div class="grid"><label class="field">实验名称<input name="name" required maxlength="100" value="' + escape(value.name) + '"></label><label class="field">实验类型<select name="template">' + Object.entries(templates).map(([id,name]) => '<option value="' + id + '" ' + (id === value.template ? 'selected' : '') + '>' + name + '</option>').join('') + '</select></label><label class="field">结果自动归档到<select name="folderId" required>' + this.options(value.folderId, false) + '</select></label></div><label class="field">这次要验证什么<input name="question" maxlength="2000" value="' + escape(value.question) + '" placeholder="例如：固定规划后，GPT 资产是否仍更难搭建？"></label><label class="field">场景提示词（多份用单独一行 --- 分隔）<textarea name="prompts" required>' + escape([...new Set(value.cases.map(item => item.prompt))].join('\n---\n')) + '</textarea></label><div class="grid"><label class="field">规划重复次数<input name="repeats" type="number" min="1" max="50" value="' + value.repeats + '"></label><label class="field">每份规划的资产重复次数<input name="assetRepeats" type="number" min="1" max="20" value="' + value.assetRepeats + '"></label><label class="field">规划模型<select name="provider">' + CHAT_PROVIDER_OPTIONS.filter(p => !p.disabled).map(p => '<option value="' + p.key + '">' + p.label + '</option>').join('') + '</select></label></div><p>资产生成模型</p><div class="tags">' + MODEL_PROVIDERS.map(p => '<label><input name="assetProvider" type="checkbox" value="' + p + '" ' + (value.assetProviders.includes(p as never) ? 'checked' : '') + '>' + p + '</label>').join('') + '</div><label class="field">API 对照组（仅 API 实验生效，可按 Ctrl 多选）<select name="profiles" multiple size="4">' + EXPERIMENT_API_PROFILES.filter(p => p !== 'editor').map(p => '<option value="' + p + '" ' + ((value.cases.some(item => item.apiProfile === p)) || p === 'core10' ? 'selected' : '') + '>' + p + '</option>').join('') + '</select></label><details><summary>地图与执行设置</summary><div class="grid"><label class="field">宽<input name="width" type="number" value="' + value.size[0] + '"></label><label class="field">高<input name="height" type="number" value="' + value.size[1] + '"></label><label class="field">深<input name="depth" type="number" value="' + value.size[2] + '"></label><label class="field">场景<select name="sceneMode"><option value="outdoor">室外</option><option value="indoor" ' + (value.sceneMode === 'indoor' ? 'selected' : '') + '>室内</option></select></label><label class="field">资产风格<select name="assetGenerationMode">' + MODEL_GENERATION_MODES.map(mode => '<option value="' + mode.key + '" ' + (mode.key === value.assetGenerationMode ? 'selected' : '') + '>' + mode.label + '</option>').join('') + '</select></label><label class="field">规划指导<select name="promptMode"><option value="standard">标准</option><option value="minimal" ' + (value.promptMode === 'minimal' ? 'selected' : '') + '>精简</option></select></label><label class="field">最少新资产<input name="minNewAssets" type="number" min="0" max="64" value="' + value.minNewAssets + '"></label><label class="field">最多新资产<input name="maxNewAssets" type="number" min="0" max="64" value="' + value.maxNewAssets + '"></label><label class="field">模型后续调整<select name="revisionMode"><option value="first-pass">关闭：保留首版代码</option><option value="repair" ' + (value.revisionMode === 'repair' ? 'selected' : '') + '>开启：修错并按资产调整</option></select></label><label class="field">程序空间修复<select name="spatialPolicy"><option value="diagnose">仅报告</option><option value="repair" ' + (value.spatialPolicy === 'repair' ? 'selected' : '') + '>修复并报告</option></select></label></div></details><details><summary>高级配置 JSON（系统提示词对照或 Agent 配置）</summary><p>填写时以此处完整配置为准。</p><textarea name="json" placeholder="可粘贴导出的 config JSON"></textarea></details><p id="trial-count"></p><div class="row"><button type="submit" class="primary">保存实验，查看任务清单</button><button id="cancel-form" type="button">取消</button></div></form>';
    const form = content.querySelector<HTMLFormElement>('form')!;
    const read = (): ExperimentConfig => {
      const data = new FormData(form);
      if (String(data.get('json')).trim()) return JSON.parse(String(data.get('json')));
      const template = String(data.get('template')) as ExperimentConfig['template'];
      const profiles = template === 'apis' ? data.getAll('profiles') : ['editor'];
      return {
        name:String(data.get('name')), question:String(data.get('question')), folderId:String(data.get('folderId')), template,
        cases:String(data.get('prompts')).split(/^\s*---\s*$/m).map(prompt => prompt.trim()).filter(Boolean).flatMap((prompt,index) => profiles.map(profile => ({
          name:config?.cases.find(item => item.prompt === prompt && item.apiProfile === profile)?.name ?? '用例 ' + (index + 1) + (template === 'apis' ? ' · ' + profile : ''), prompt, apiProfile:String(profile) as ExperimentConfig['cases'][number]['apiProfile']
        }))),
        repeats:Number(data.get('repeats')), assetRepeats:Number(data.get('assetRepeats')),
        provider:String(data.get('provider')) as ExperimentConfig['provider'], assetProviders:data.getAll('assetProvider') as ExperimentConfig['assetProviders'],
        size:[Number(data.get('width')),Number(data.get('height')),Number(data.get('depth'))],
        sceneMode:String(data.get('sceneMode')) as ExperimentConfig['sceneMode'], assetGenerationMode:String(data.get('assetGenerationMode')) as ExperimentConfig['assetGenerationMode'],
        minNewAssets:Number(data.get('minNewAssets')), maxNewAssets:Number(data.get('maxNewAssets')),
        promptMode:String(data.get('promptMode')) as ExperimentConfig['promptMode'],
        revisionMode:String(data.get('revisionMode')) as ExperimentConfig['revisionMode'], spatialPolicy:String(data.get('spatialPolicy')) as ExperimentConfig['spatialPolicy']
      };
    };
    if (config?.cases.some(item => item.systemPrompt)) (form.elements.namedItem('json') as HTMLTextAreaElement).value = JSON.stringify(config, null, 2);
    form.oninput = () => {
      try { const c = read(); const count = c.cases.length * c.repeats * c.assetProviders.length * c.assetRepeats; form.querySelector('#trial-count')!.textContent = '将生成 ' + count + ' 个结果；' + (c.template === 'assets' ? '同一重复组共用规划。' : '每个结果独立规划。') + ' 保存不会调用模型。'; } catch { form.querySelector('#trial-count')!.textContent = '请检查配置。'; }
    };
    form.dispatchEvent(new Event('input'));
    form.onsubmit = event => { event.preventDefault(); this.action(async () => {
      const result = await api<{ experiment:Experiment }>('experiments', read());
      this.jobId = result.experiment.id; await this.reload(); this.render(); this.notice('实验已保存。检查清单后点击“开始 / 继续”。');
    }); };
    content.querySelector<HTMLElement>('#cancel-form')!.onclick = () => this.renderJob();
  }
  private async refreshJobs(): Promise<void> {
    const previous = JSON.stringify(this.jobs);
    this.jobs = (await api<{ experiments:Experiment[] }>('experiments')).experiments;
    if (previous === JSON.stringify(this.jobs)) return;
    const [maps, catalog] = await Promise.all([api<{ maps:MapSummary[] }>('maps'), api<MapCatalog>('map-folders')]);
    this.maps = maps.maps; this.catalog = catalog;
    this.callbacks.catalogChanged(this.catalog, this.maps);
    this.app.querySelectorAll<HTMLElement>('[data-folder]').forEach(button => {
      const id = button.dataset.folder;
      const count = button.querySelector('span');
      if (count) count.textContent = String(this.maps.filter(map => id === 'all' || (this.catalog.membership[map.id] ?? 'unfiled') === id).length);
    });
    this.app.querySelectorAll<HTMLOptionElement>('#experiment-select option').forEach(option => {
      const job = this.jobs.find(item => item.id === option.value);
      if (job) option.textContent = job.config.name + ' · ' + statusNames[job.status];
    });
    if (!this.reviewRun && !this.app.querySelector('#experiment-form')) this.renderJob();
  }
  private renderJob(): void {
    this.dispose();
    const root = this.app.querySelector('#experiment-detail')!;
    const job = this.jobs.find(job => job.id === this.jobId);
    if (!job) { root.innerHTML = '<div class="empty">创建实验，或选择一批已有结果。</div>'; return; }
    const completed = job.runs.filter(run => run.status === 'completed');
    const reviewed = job.runs.filter(run => run.humanReview);
    const durations = completed.filter(run => run.finishedAt && run.startedAt).map(run => run.finishedAt! - run.startedAt!).sort((a,b) => a-b);
    root.innerHTML = '<div class="panel"><div class="row"><h3>' + escape(job.config.name) + '</h3><span class="badge">' + statusNames[job.status] + '</span><span class="spacer"></span><button data-control="start" class="primary" ' + (job.status === 'running' ? 'disabled' : '') + '>开始 / 继续</button><button data-control="pause">暂停队列</button><button id="copy-experiment">复制配置</button><button id="export-experiment">导出记录</button></div><p>' + escape(job.config.question || templates[job.config.template]) + '</p><p>归档到 ' + escape(this.folderPath(job.config.folderId)) + ' · ' + job.runs.length + ' 次尝试 · ' + completed.length + ' 个完成 · ' + job.runs.filter(run => run.status === 'partial').length + ' 个部分资产失败 · ' + job.runs.filter(run => run.status === 'failed' || run.status === 'interrupted').length + ' 个失败 / 中断 · ' + reviewed.length + ' 个已审查' + (durations.length ? ' · 完成项耗时中位数 ' + Math.round(durations[Math.floor(durations.length / 2)] / 1000) + ' 秒' : '') + '</p><details><summary>查看冻结的配置与代码版本</summary><pre>' + escape(JSON.stringify({ config:job.config, sourceVersion:job.sourceVersion },null,2)) + '</pre></details></div><div class="row"><label>筛选 <select id="run-filter"><option value="all">全部结果</option><option value="unreviewed">待人工审查</option><option value="failed">失败 / 中断</option></select></label><label><input id="blind" type="checkbox" ' + (this.blind ? 'checked' : '') + '>审查时隐藏分组条件</label></div><div class="panel table-wrap"><table><thead><tr><th>结果</th><th>规划组</th><th>状态 / 进度</th><th>评价</th><th>操作</th></tr></thead><tbody id="run-rows"></tbody></table></div><div id="review-area"></div>';
    root.querySelectorAll<HTMLElement>('[data-control]').forEach(button => button.onclick = () => this.control(button.dataset.control!));
    root.querySelector<HTMLElement>('#copy-experiment')!.onclick = () => this.experimentForm({ ...job.config, name:job.config.name + ' 副本' });
    root.querySelector<HTMLElement>('#export-experiment')!.onclick = () => {
      const link=document.createElement('a'); const url=URL.createObjectURL(new Blob([JSON.stringify(job,null,2)],{type:'application/json'}));
      link.href=url; link.download=job.id+'.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    };
    const filter = root.querySelector<HTMLSelectElement>('#run-filter')!; filter.value = this.reviewFilter;
    filter.onchange = () => { this.reviewFilter=filter.value; this.renderRunRows(job); };
    root.querySelector<HTMLInputElement>('#blind')!.onchange = event => { this.blind=(event.target as HTMLInputElement).checked; this.renderRunRows(job); if(this.reviewRun) this.openReview(this.reviewRun); };
    this.renderRunRows(job);
    if (this.reviewRun) this.openReview(this.reviewRun);
  }
  private renderRunRows(job: Experiment): void {
    const runs=job.runs.filter(run => this.reviewFilter==='unreviewed' ? !run.humanReview && ['completed','partial'].includes(run.status) : this.reviewFilter==='failed' ? ['failed','interrupted','partial'].includes(run.status) : true);
    this.app.querySelector('#run-rows')!.innerHTML=runs.map(run => '<tr><td>' + (this.blind ? '结果 ' + (job.runs.indexOf(run) + 1) : escape(job.config.cases[run.caseIndex].name)) + ' · R' + run.repeat + '<small>' + (this.blind ? '条件已隐藏' : escape(run.assetProvider)) + ' · 资产 ' + run.assetRepeat + ' · 尝试 ' + run.attempt + '</small></td><td>' + (this.blind ? '规划 ' + ([...new Set(job.runs.map(item => item.planKey))].indexOf(run.planKey) + 1) : escape(run.planKey)) + '</td><td><span class="status-' + run.status + '">' + statusNames[run.status] + '</span><small>' + escape(run.error || run.progress || run.stage || '') + '</small></td><td>' + (run.humanReview ? '已审查' : run.agentReview ? 'Agent 已初评' : '待评价') + '</td><td><div class="row">' + (['completed','partial'].includes(run.status) ? '<button data-review="' + run.id + '">审查 / 对照</button><button data-run-action="regenerate" data-run="' + run.id + '">同规划重生成资产</button><button data-run-action="replay" data-run="' + run.id + '">复用资产重放</button>' : ['failed','interrupted','cancelled'].includes(run.status) ? '<button data-run-action="retry" data-run="' + run.id + '">重试</button>' : '<button data-run-action="cancel" data-run="' + run.id + '">取消</button>') + '</div></td></tr>').join('');
    this.app.querySelectorAll<HTMLElement>('[data-review]').forEach(button=>button.onclick=()=>this.openReview(button.dataset.review!));
    this.app.querySelectorAll<HTMLElement>('[data-run-action]').forEach(button=>button.onclick=()=>this.control(button.dataset.runAction!,button.dataset.run));
  }
  private control(action:string,runId?:string):void { this.action(async()=>{
    await api('experiments/'+this.jobId+'/control',{action,runId}); await this.refreshJobs();
    if(action==='start')this.notice('队列已启动，关闭页面后后台仍会继续。');
    if(action==='pause')this.notice('已暂停队列；当前运行完成后停止。');
    if(action==='retry'||action==='replay'||action==='regenerate')this.notice('已加入队列。点击“开始 / 继续”执行；原记录保留。');
  }); }
  private openReview(runId:string):void {
    this.dispose(); this.reviewRun=runId;
    const job=this.jobs.find(job=>job.id===this.jobId)!; const run=job.runs.find(run=>run.id===runId)!;
    const review=run.humanReview; const others=job.runs.filter(other=>['completed','partial'].includes(other.status)&&other.id!==runId);
    const paired=[...others].reverse().find(other=>other.planKey===run.planKey && other.assetProvider!==run.assetProvider) ?? others.find(other=>other.planKey===run.planKey);
    const compared=review?.comparedRunId??paired?.id??'';
    const root=this.app.querySelector('#review-area')!;
    root.innerHTML='<div class="panel"><div class="row"><h3>结果审查</h3><span class="spacer"></span><button id="close-review">关闭</button></div><div class="review"><div><div class="pair"><div><p>A · 当前结果 '+(this.blind?'':escape(run.assetProvider))+'</p><canvas id="preview-a" class="preview"></canvas></div><div><label class="field">B · 对照结果<select id="compare-run"><option value="">不对照</option>'+others.map((other,index)=>'<option value="'+other.id+'" '+(other.id===compared?'selected':'')+'>'+ (this.blind?'结果 '+(job.runs.indexOf(other)+1):escape(job.config.cases[other.caseIndex].name+' · '+other.assetProvider+' · R'+other.repeat))+(other.planKey===run.planKey?' · 同一规划':'')+'</option>').join('')+'</select></label><canvas id="preview-b" class="preview"></canvas></div></div><p>拖动旋转，滚轮缩放。使用统一的中性查看设置。</p><div class="row"><button id="reset-view">重置视角</button><button data-open-map="'+run.mapId+'">在上方查看地图</button><button id="view-evidence">查看规划 / 生成证据</button></div><pre id="run-evidence"></pre></div><form id="review-form" class="review-form">'+(['prompt','layout','assets','assembly'] as const).map((key,index)=>'<label class="field">'+['提示词满足程度','布局与空间组织','资产本身质量','搭建与连接'][index]+'<select name="'+key+'">'+Object.entries(ratingNames).map(([value,name])=>'<option value="'+value+'" '+(review?.[key]===value?'selected':'')+'>'+name+'</option>').join('')+'</select></label>').join('')+'<div class="tags">'+REVIEW_TAGS.map(tag=>'<label><input type="checkbox" name="tags" value="'+tag+'" '+(review?.tags.includes(tag)?'checked':'')+'>'+tag+'</label>').join('')+'</div><label class="field">配对偏好<select name="preference">'+[['','未比较'],['this','A 更好'],['other','B 更好'],['tie','接近'],['unknown','无法比较']].map(([value,name])=>'<option value="'+value+'" '+(review?.preference===value?'selected':'')+'>'+name+'</option>').join('')+'</select></label><label class="field">补充说明<textarea name="note" maxlength="4000">'+escape(review?.note??'')+'</textarea></label>'+(run.agentReview?'<details open><summary>Agent 初评（尚不代表人工结论）</summary><pre>'+escape(JSON.stringify(run.agentReview,null,2))+'</pre><button type="button" id="accept-agent">填入 Agent 初评</button></details>':'')+'<button class="primary" type="submit">保存人工评价并查看下一项</button></form></div></div>';
    root.scrollIntoView({ block:'start' });
    const form=root.querySelector<HTMLFormElement>('#review-form')!;
    const compare=root.querySelector<HTMLSelectElement>('#compare-run')!;
    const show=()=>this.action(async()=>{this.dispose();const version=this.previewVersion;await Promise.all([this.preview(runId,'#preview-a',version),compare.value?this.preview(compare.value,'#preview-b',version):Promise.resolve()]);});
    compare.onchange=()=>{(form.elements.namedItem('preference') as HTMLSelectElement).value='';show();};
    root.querySelector<HTMLElement>('#reset-view')!.onclick=show;
    root.querySelector<HTMLElement>('#close-review')!.onclick=()=>{this.reviewRun='';this.renderJob();};
    root.querySelector<HTMLElement>('#view-evidence')!.onclick=()=>this.action(async()=>{
      const [plan,result]=await Promise.all([api('experiments/'+job.id+'/runs/'+run.id+'/artifacts/plan'),api('experiments/'+job.id+'/runs/'+run.id+'/artifacts/result')]);
      root.querySelector('#run-evidence')!.textContent=JSON.stringify({plan,result},null,2);
    });
    root.querySelector<HTMLElement>('#accept-agent')?.addEventListener('click',()=>{
      const source=run.agentReview!;
      for(const key of ['prompt','layout','assets','assembly','note'] as const)(form.elements.namedItem(key) as HTMLInputElement).value=source[key];
      form.querySelectorAll<HTMLInputElement>('[name=tags]').forEach(input=>input.checked=source.tags.includes(input.value));
    });
    form.onsubmit=event=>{event.preventDefault();this.action(async()=>{
      const data=new FormData(form);
      const review={prompt:data.get('prompt'),layout:data.get('layout'),assets:data.get('assets'),assembly:data.get('assembly'),tags:data.getAll('tags'),note:data.get('note'),comparedRunId:compare.value||undefined,preference:data.get('preference')};
      await api('experiments/'+job.id+'/runs/'+run.id+'/reviews/human',review,'PUT');
      this.reviewRun='';await this.refreshJobs();this.renderJob();
      const next=this.jobs.find(j=>j.id===job.id)!.runs.find(r=>['completed','partial'].includes(r.status)&&!r.humanReview);
      if(next)this.openReview(next.id);else this.notice('评价已保存，当前批次已无待审查的完成项。');
    });};
    show();
  }
  private async preview(runId:string,selector:string,version:number):Promise<void>{
    const map=await api<EditableMap>('experiments/'+this.jobId+'/runs/'+runId+'/artifacts/snapshot');
    if(version!==this.previewVersion)return;
    const canvas=this.app.querySelector<HTMLCanvasElement>(selector)!;
    const viewer=await createMapViewer({canvas,map,scheme:null,pixelRatio:1});
    if(version!==this.previewVersion){viewer.dispose();return;}
    const [width,height,depth]=map.box.size;
    viewer.camera.position.set(width*.75,Math.max(height*1.5,width*.6),depth*.85);
    const controls=new OrbitControls(viewer.camera,canvas);controls.target.set(0,height*.12,0);controls.update();
    const resize=()=>viewer.setSize(Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));
    const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
    this.viewers.push({viewer,controls,observer});
    if (!this.visible) viewer.stop();
  }
}
