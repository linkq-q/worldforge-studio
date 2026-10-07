import type { MapDesignDraft, MapDesignSessionOptions, MapDesignSessionView } from '../shared/mapDesignSession';
import type { EditableMap } from '../shared/map';
import type { MapTransactionSummary } from '../shared/mapOperations';
import type { SceneAppearancePlan } from '../shared/sceneAppearance';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type CommitResult = { map: EditableMap; transaction: MapTransactionSummary; session: MapDesignSessionView };
export interface DesignContext { mapId: string; version: number; blocked?: string }
interface DesignHooks {
  changed(): void;
  blocked?(): string;
  draft(value: MapDesignDraft): Promise<boolean>;
  committed(value: CommitResult): Promise<void>;
  reset?(): void;
}

/** A map-bound client; late requests never change a different map's conversation. */
export class MapDesignSessionClient {
  session: MapDesignSessionView | null = null;
  context: DesignContext | null = null;
  error = '';
  pending = false;
  loading = false;
  private epoch = 0;
  private recoveryPending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draft: MapDesignDraft | null = null;
  private displayedRevision = -1;
  private readyPlanRevision = -1;

  constructor(private request: Request, private hooks: DesignHooks, private pollMs = 1_000) {}

  get assetRequirements() { return this.draft?.suggestion?.codePlan?.assetRequirements ?? []; }
  get planDisplayed(): boolean { return this.readyPlanRevision === this.session?.draftRevision; }

  get blocked(): string {
    const liveBlock = this.hooks.blocked?.();
    if (liveBlock) return liveBlock;
    if (this.context?.blocked) return this.context.blocked;
    if (this.session && this.session.baseVersion !== this.context?.version) {
      return '地图已在会话外更新。草稿仍保留，请回到原版本或开启新的对话。';
    }
    return '';
  }

  async connect(context: DesignContext | null): Promise<void> {
    if (this.context?.mapId === context?.mapId) {
      const changed = this.context?.blocked !== context?.blocked || this.context?.version !== context?.version;
      this.context = context;
      if (changed) {
        this.hooks.changed();
        if (!this.blocked) await this.showDraft();
      }
      return;
    }
    this.disconnect();
    this.context = context;
    if (!context) return;
    const epoch = this.epoch;
    this.recoveryPending = true;
    await this.recover();
    if (epoch === this.epoch) this.schedule();
  }

  private async recover(): Promise<void> {
    const context = this.context, epoch = this.epoch;
    if (!context) return;
    this.loading = true;
    this.hooks.changed();
    try {
      const { sessions } = await this.request<{ sessions: MapDesignSessionView[] }>(
        `/api/editor/maps/${encodeURIComponent(context.mapId)}/design-sessions`);
      if (epoch !== this.epoch) return;
      this.recoveryPending = false;
      this.error = '';
      const latest = sessions.filter(item => item.mapId === context.mapId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) await this.accept(latest, epoch);
    } catch (error) {
      if (epoch === this.epoch) this.error = `${this.recoveryPending ? '恢复对话失败，正在重试。' : ''}${errorText(error)}`;
    } finally {
      if (epoch === this.epoch) {
        // An unavailable list is not an empty list: do not create a second session.
        this.loading = this.recoveryPending;
        this.hooks.changed();
      }
    }
  }

  disconnect(): void {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.context = null;
    this.session = null;
    this.draft = null;
    this.displayedRevision = -1;
    this.readyPlanRevision = -1;
    this.pending = false;
    this.loading = false;
    this.recoveryPending = false;
    this.error = '';
  }

  async send(message: string, options: Omit<MapDesignSessionOptions, 'prompt' | 'expectedVersion'> = {}): Promise<boolean> {
    const context = this.context;
    if (!context || !message.trim() || this.pending || this.loading || this.blocked) return false;
    const session = this.session;
    if (!session && (options.assetIds?.length ?? 0) > 64) {
      this.error = `当前资产库有 ${options.assetIds!.length} 个资产，超过单次设计会话的 64 个限制。请选择较小的资产库，或关闭复用资产后创建对话；不会自动截断资产列表。`;
      this.hooks.changed();
      return false;
    }
    return this.action(async epoch => {
      const { session: next } = session
        ? await this.request<{ session: MapDesignSessionView }>(this.path(session.id, '/messages'), post({ message }))
        : await this.request<{ session: MapDesignSessionView }>(
          `/api/editor/maps/${encodeURIComponent(context.mapId)}/design-sessions`,
          post({ ...options, prompt: message, expectedVersion: context.version }));
      if (epoch !== this.epoch) return;
      if (next.id !== this.session?.id) { this.draft = null; this.displayedRevision = -1; this.session = null; }
      await this.accept(next, epoch);
    });
  }

  fresh(): void {
    if (this.pending || this.session?.status === 'running') return;
    const context = this.context;
    this.disconnect();
    this.context = context;
    this.hooks.reset?.();
    this.hooks.changed();
  }

  async control(command: 'pause' | 'resume'): Promise<boolean> {
    const session = this.session;
    if (!session || this.pending || command === 'resume' && (this.blocked || session.stage === 'awaiting-plan-approval')) return false;
    return this.action(async epoch => {
      const { session: next } = await this.request<{ session: MapDesignSessionView }>(this.path(session.id, `/${command}`), post({}));
      await this.accept(next, epoch);
    });
  }

  async commit(): Promise<boolean> {
    const session = this.session;
    if (!session || this.blocked || this.pending || session.status === 'running' || session.status === 'committed'
      || session.operationCount <= 0 || session.stage && session.stage !== 'completed') return false;
    return this.action(async epoch => {
      const result = await this.request<CommitResult>(this.path(session.id, '/commit'),
        post({ expectedRevision: session.draftRevision, approved: true }));
      if (epoch !== this.epoch || result.map.id !== this.context?.mapId) return;
      // Commit changes the official map version; do not briefly classify it as stale.
      this.session = result.session;
      this.context = { ...this.context, version: result.map.version };
      this.draft = null;
      this.displayedRevision = -1;
      await this.hooks.committed(result);
      if (epoch === this.epoch) this.hooks.changed();
    });
  }

  async approvePlan(): Promise<boolean> {
    const session = this.session;
    if (!session || this.pending || this.blocked || session.stage !== 'awaiting-plan-approval' || !this.planDisplayed) return false;
    return this.action(async epoch => {
      const {session:next} = await this.request<{session:MapDesignSessionView}>(this.path(session.id,'/approve-plan'),
        post({expectedRevision:session.draftRevision,approved:true}));
      await this.accept(next,epoch);
    });
  }

  async poll(): Promise<void> {
    const session = this.session, epoch = this.epoch;
    if (!session || this.pending) return;
    try {
      const { session: next } = await this.request<{ session: MapDesignSessionView | null }>(
        this.path(session.id, `?sinceVersion=${session.version}`));
      if (epoch !== this.epoch || this.session?.id !== session.id) return;
      // An unchanged session needs no redraw, but a previously failed draft fetch can retry.
      await this.accept(next ?? this.session, epoch);
      if (this.error) { this.error = ''; this.hooks.changed(); }
    } catch (error) {
      const nextError = `连接中断，正在重连。${errorText(error)}`;
      if (epoch === this.epoch && this.error !== nextError) { this.error = nextError; this.hooks.changed(); }
    }
  }

  /** The renderer can fail after accepting a draft; retry its cached geometry on the next poll. */
  invalidateDraft(draftRevision: number): void {
    if (this.draft?.session.draftRevision === draftRevision && this.displayedRevision === draftRevision) {
      this.displayedRevision = -1;
      this.readyPlanRevision = -1;
    }
  }

  private async action(work: (epoch: number) => Promise<void>): Promise<boolean> {
    const epoch = this.epoch;
    this.pending = true;
    this.error = '';
    this.hooks.changed();
    try {
      await work(epoch);
      return epoch === this.epoch;
    } catch (error) {
      if (epoch === this.epoch) this.error = errorText(error);
      return false;
    } finally {
      if (epoch === this.epoch) { this.pending = false; this.hooks.changed(); this.schedule(); }
    }
  }

  private async accept(session: MapDesignSessionView, epoch: number): Promise<void> {
    if (epoch !== this.epoch || session.mapId !== this.context?.mapId) return;
    if (this.session && (session.id !== this.session.id || session.version < this.session.version)) return;
    if (!this.session || session.version !== this.session.version) {
      this.session = session;
      this.hooks.changed();
    }
    if (session.status === 'committed' || session.operationCount <= 0) return;
    if (!this.draft || this.draft.session.draftRevision !== session.draftRevision) {
      const draft = await this.request<MapDesignDraft>(this.path(session.id, '/draft'));
      if (epoch !== this.epoch || this.session?.id !== session.id || draft.session.id !== session.id
        || draft.map.id !== this.context?.mapId || draft.session.draftRevision < this.session.draftRevision) return;
      this.draft = draft;
    }
    await this.showDraft();
  }

  private async showDraft(): Promise<void> {
    const draft = this.draft, epoch = this.epoch;
    if (!draft || this.blocked || draft.session.draftRevision === this.displayedRevision) return;
    // Reserve the revision before the async renderer: a status update can arrive
    // during scene construction and must not schedule the same rebuild twice.
    this.displayedRevision = draft.session.draftRevision;
    try {
      const accepted = await this.hooks.draft(draft);
      if (!accepted && epoch === this.epoch) this.displayedRevision = -1;
      if (accepted && epoch === this.epoch) {
        this.readyPlanRevision = draft.session.draftRevision;
        this.hooks.changed();
      }
    } catch (error) {
      if (epoch === this.epoch) this.displayedRevision = -1;
      throw error;
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.context || !this.pollMs || !this.recoveryPending && (!this.session || this.session.status === 'committed')) return;
    const epoch = this.epoch;
    this.timer = setTimeout(async () => {
      if (this.recoveryPending) await this.recover();
      else await this.poll();
      if (epoch === this.epoch) this.schedule();
    }, this.pollMs);
  }

  private path(id: string, suffix = ''): string { return `/api/editor/design-sessions/${encodeURIComponent(id)}${suffix}`; }
}

function post(body: unknown): RequestInit { return { method: 'POST', body: JSON.stringify(body) }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function renderDesignMessages(session: MapDesignSessionView | null): string {
  if (!session?.messages.length) return '<p class="design-empty">描述你想制作的地图，也可以继续讨论地形、建筑和游玩路线。生成过程中随时补充要求。</p>';
  return session.messages.map(message => message.role === 'tool'
    ? `<details class="design-tool" data-design-message="${escape(message.id)}"><summary>${escape(message.action ?? '场景操作')}${message.draftRevision ? ` · 草稿 ${message.draftRevision}` : ''}</summary><pre>${escape(message.content)}</pre></details>`
    : `<article class="design-message design-message-${message.role}"><b>${message.role === 'user' ? '你' : 'WorldForge'}${message.interrupted ? ' · 已中断' : ''}</b><div>${escape(message.content)}</div></article>`).join('');
}

export function renderDesignAppearance(plan?: SceneAppearancePlan): string {
  if (!plan) return '';
  return `<strong>场景配色</strong><p>${escape(plan.intent)}</p><ul>${plan.materials.map(material =>
    `<li><i aria-hidden="true" style="background:${/^#[\da-f]{6}$/i.test(material.color) ? material.color : 'transparent'}"></i><span>${escape(material.role)} <code>${escape(material.color)}</code>${material.notes ? ` · ${escape(material.notes)}` : ''}</span></li>`
  ).join('')}</ul><small>新生成资产继承这些源色；复用资产保留原色。地表与环境配色在确认地图后进入渲染草稿。</small>`;
}

export function renderDesignAssetPrompts(requirements: NonNullable<NonNullable<MapDesignDraft['suggestion']>['codePlan']>['assetRequirements']): string {
  if (!requirements?.length) return '';
  return `<strong>已规划的资产提示表</strong><p>尺寸单位为米；颜色提示随已确认的规划发送给资产模型。</p>${requirements.map(item=>
    `<details><summary>${escape(item.name)} · ${item.variants} 个${item.dimensions ? ` · ${item.dimensions.join(' × ')} m` : ''}</summary><pre>${escape(item.prompt ?? '此旧规划没有保存提示文本')}${item.variantPrompts ? '\n'+item.variantPrompts.map(escape).join('\n') : ''}</pre></details>`
  ).join('')}`;
}

export function designGenerationStatus(session: MapDesignSessionView): string {
  const counts = session.generationCounts;
  const generation = counts ? `整轮规划 ${counts.planning} 次 · 资产整批 ${counts.assets} 次${
    session.generationCallLimit === undefined ? '' : ` · 生成次数 ${counts.planning + counts.assets}/${session.generationCallLimit}`}` : '';
  return [generation, `内部 GPT 往返 ${session.modelCalls} 次 · 单个资产尝试 ${session.assetCalls} 个`,
    session.paidRequestLimit === undefined ? '' : `底层 HTTP 请求 ${session.paidRequests ?? 0}/${session.paidRequestLimit}`].filter(Boolean).join(' · ');
}

/** Mount once. Only messages and status update, so typing and IME composition survive polling. */
export class MapDesignConversation {
  private mapId = '';
  private drafts = new Map<string, string>();
  private messageKey = '';
  private input: HTMLTextAreaElement;
  private clock: ReturnType<typeof setInterval>;
  constructor(private host: HTMLElement, private client: MapDesignSessionClient,
    options: () => Omit<MapDesignSessionOptions, 'prompt' | 'expectedVersion'>,
    compare: (after: boolean) => void, private showingDraft: () => boolean) {
    host.innerHTML = `<section class="map-design-conversation" aria-label="地图设计对话">
      <header><div><strong>主模式 · 持续设计</strong><p>先检查白盒、尺寸与配色；你确认后，同一会话生成资产</p></div><div><span data-design-status></span><button type="button" class="secondary small" data-design-new hidden>新对话</button></div></header>
      <div class="design-messages" data-design-messages role="log" aria-label="对话与执行记录"></div>
      <div class="design-progress" data-design-progress role="status"></div>
      <aside class="design-appearance" data-design-appearance hidden></aside>
      <aside class="design-asset-prompts" data-design-asset-prompts hidden></aside>
      <button type="button" data-design-approve-plan hidden>确认白盒与配色，开始生成资产</button>
      <p class="design-error" data-design-error role="alert" hidden></p>
      <div class="design-preview-actions" data-design-preview hidden>
        <button type="button" class="secondary" data-design-before>修改前</button>
        <button type="button" class="secondary" data-design-after>当前草稿</button>
        <button type="button" data-design-commit>应用到地图</button>
      </div>
      <form class="design-composer"><label for="map-design-message">告诉我你的想法</label>
        <textarea id="map-design-message" rows="3" maxlength="12000" placeholder="例如：保留粗犷的山体，在河边布置能自由探索的小镇，房屋之间用道路连接。"></textarea>
        <div class="design-composer-actions"><button type="button" class="secondary" data-design-control hidden></button><span data-design-elapsed></span><button type="submit" data-design-send>发送</button></div>
      </form></section>`;
    this.input = host.querySelector('textarea')!;
    this.input.addEventListener('input', () => { this.drafts.set(this.mapId, this.input.value); this.renderControls(); });
    host.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      const message = this.input.value, mapId = this.mapId;
      void client.send(message, options()).then(sent => {
        if (sent && this.mapId === mapId && this.input.value === message) {
          this.input.value = ''; this.drafts.set(mapId, '');
        }
        this.renderControls();
      });
    });
    host.querySelector('[data-design-control]')!.addEventListener('click', () => {
      void client.control(client.session?.status === 'running' ? 'pause' : 'resume');
    });
    host.querySelector('[data-design-commit]')!.addEventListener('click', () => void client.commit());
    host.querySelector('[data-design-approve-plan]')!.addEventListener('click', () => void client.approvePlan());
    host.querySelector('[data-design-new]')!.addEventListener('click', () => client.fresh());
    host.querySelector('[data-design-before]')!.addEventListener('click', () => { compare(false); this.renderControls(); });
    host.querySelector('[data-design-after]')!.addEventListener('click', () => { compare(true); this.renderControls(); });
    this.clock = setInterval(() => this.renderElapsed(), 1_000);
    this.render();
  }

  render(): void {
    const mapId = this.client.context?.mapId ?? '';
    if (mapId !== this.mapId) {
      this.drafts.set(this.mapId, this.input.value);
      this.mapId = mapId;
      this.input.value = this.drafts.get(mapId) ?? '';
    }
    const session = this.client.session;
    const appearance = this.host.querySelector<HTMLElement>('[data-design-appearance]')!;
    const appearanceHtml = renderDesignAppearance(session?.appearancePlan);
    if (appearance.innerHTML !== appearanceHtml) appearance.innerHTML = appearanceHtml;
    appearance.hidden = !appearanceHtml;
    const prompts = this.host.querySelector<HTMLElement>('[data-design-asset-prompts]')!;
    const promptsHtml = renderDesignAssetPrompts(this.client.assetRequirements);
    if (prompts.innerHTML !== promptsHtml) prompts.innerHTML = promptsHtml;
    prompts.hidden = !promptsHtml;
    const key = `${session?.id}:${JSON.stringify(session?.messages ?? [])}`;
    if (key !== this.messageKey) {
      this.messageKey = key;
      const messages = this.host.querySelector<HTMLElement>('[data-design-messages]')!;
      const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
      const open = new Set([...messages.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.dataset.designMessage));
      messages.innerHTML = renderDesignMessages(session);
      messages.querySelectorAll<HTMLDetailsElement>('details').forEach(item => { item.open = open.has(item.dataset.designMessage); });
      if (bottom) messages.scrollTop = messages.scrollHeight;
    }
    this.renderControls();
  }

  private renderControls(): void {
    const { session, pending, loading, blocked, error } = this.client;
    const status = session?.status;
    const awaitingPlan = session?.stage === 'awaiting-plan-approval';
    this.host.querySelector('[data-design-status]')!.textContent = loading ? '恢复对话…' : awaitingPlan ? '等待确认白盒'
      : ({ running: '正在制作', paused: '已暂停', failed: '需要处理', committed: '已应用', idle: '等待你的想法' }[status ?? 'idle']);
    const progress = this.host.querySelector('[data-design-progress]')!;
    const progressText = session ? [session.progress?.label, session.progress?.detail,
      designGenerationStatus(session)].filter(Boolean).join(' · ') : '';
    if (progress.textContent !== progressText) progress.textContent = progressText;
    const issue = this.host.querySelector<HTMLElement>('[data-design-error]')!;
    const issueText = blocked || error || session?.error || '';
    if (issue.textContent !== issueText) issue.textContent = issueText;
    issue.hidden = !issue.textContent;
    const send = this.host.querySelector<HTMLButtonElement>('[data-design-send]')!;
    send.disabled = pending || loading || Boolean(blocked) || !this.input.value.trim() || !this.client.context;
    send.textContent = status === 'running' ? '发送并调整' : '发送';
    const control = this.host.querySelector<HTMLButtonElement>('[data-design-control]')!;
    control.hidden = awaitingPlan || !status || status === 'idle' || status === 'committed';
    control.disabled = pending || status !== 'running' && Boolean(blocked);
    control.textContent = status === 'running' ? '暂停' : '继续';
    const fresh = this.host.querySelector<HTMLButtonElement>('[data-design-new]')!;
    fresh.hidden = !session;
    fresh.disabled = pending || status === 'running';
    this.host.querySelector<HTMLElement>('[data-design-preview]')!.hidden = !session?.operationCount || status === 'committed';
    this.host.querySelector('[data-design-before]')!.setAttribute('aria-pressed', String(!this.showingDraft()));
    this.host.querySelector('[data-design-after]')!.setAttribute('aria-pressed', String(this.showingDraft()));
    this.host.querySelector<HTMLButtonElement>('[data-design-commit]')!.disabled = pending || status === 'running' || Boolean(blocked)
      || Boolean(session?.stage && session.stage !== 'completed');
    const approve = this.host.querySelector<HTMLButtonElement>('[data-design-approve-plan]')!;
    approve.hidden = !awaitingPlan;
    approve.disabled = pending || Boolean(blocked) || !this.client.planDisplayed;
    this.renderElapsed();
  }

  private renderElapsed(): void {
    const session = this.client.session;
    const seconds = session ? Math.max(0, Math.floor(((session.status === 'running' ? Date.now() : session.updatedAt) - session.createdAt) / 1000)) : 0;
    this.host.querySelector('[data-design-elapsed]')!.textContent = session
      ? `会话 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  }

  dispose(): void { clearInterval(this.clock); this.client.disconnect(); }
}
