import { describe, expect, it, vi } from 'vitest';
import { ExperimentWorkspace } from '../src/client/experimentWorkspace';

function host() {
  const listeners = new Map<string, (event: unknown) => void>();
  const notice = { textContent: '', classList: { toggle: vi.fn() } };
  const app = {
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    querySelector: () => notice,
    innerHTML: '<form>unsaved review</form>'
  };
  const callbacks = { openMap: vi.fn(async () => true), catalogChanged: vi.fn() };
  const workspace = new ExperimentWorkspace(app as unknown as HTMLElement, callbacks);
  return { workspace, app, callbacks, notice, listeners };
}

describe('embedded experiment workspace', () => {
  it('retains the existing form when collapsing and reopening the same panel', () => {
    const { workspace, app } = host();
    const original = app.innerHTML;
    workspace.setVisible(false);
    workspace.open('maps');
    expect(app.innerHTML).toBe(original);
  });

  it('pauses hidden review previews and resumes them without recreating them', () => {
    const { workspace } = host();
    const viewer = { start: vi.fn(), stop: vi.fn() };
    (workspace as unknown as { viewers: unknown[] }).viewers = [{ viewer }];
    workspace.setVisible(false);
    expect(viewer.stop).toHaveBeenCalledOnce();
    workspace.open('maps');
    expect(viewer.start).toHaveBeenCalledOnce();
  });

  it.each([true, false])('uses the editor map-switch result (%s) without navigating', async accepted => {
    const { workspace, callbacks, listeners, notice } = host();
    callbacks.openMap.mockResolvedValue(accepted);
    const button = { dataset: { openMap: 'existing-map' }, setAttribute: vi.fn(), removeAttribute: vi.fn() };
    listeners.get('click')!({ target: { closest: () => button } });
    await vi.waitFor(() => expect(button.removeAttribute).toHaveBeenCalledWith('disabled'));
    expect(callbacks.openMap).toHaveBeenCalledWith('existing-map');
    expect(notice.textContent.includes('已在上方')).toBe(accepted);
    workspace.setVisible(false);
  });

  it('surfaces an editor rejection and re-enables the result button', async () => {
    const { callbacks, listeners, notice } = host();
    callbacks.openMap.mockRejectedValue(new Error('当前编辑器正在生成'));
    const button = { dataset: { openMap: 'existing-map' }, setAttribute: vi.fn(), removeAttribute: vi.fn() };
    listeners.get('click')!({ target: { closest: () => button } });
    await vi.waitFor(() => expect(notice.textContent).toBe('当前编辑器正在生成'));
    expect(button.removeAttribute).toHaveBeenCalledWith('disabled');
  });
});
