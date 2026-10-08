import { describe, expect, it, vi } from 'vitest';
const electron=vi.hoisted(()=>({contextBridge:{exposeInMainWorld:vi.fn()},ipcRenderer:{invoke:vi.fn(),send:vi.fn(),on:vi.fn(),removeListener:vi.fn()}}));
vi.mock('electron',()=>electron);

describe('presenter approval renderer boundary',()=>{
  it('exposes pending/status observation and Stop, without an approval capability',async()=>{
    await import('./preload');
    const api=electron.contextBridge.exposeInMainWorld.mock.calls.find(([name])=>name==='orca')?.[1];
    expect(api).toBeDefined();
    expect(api.approveToolCall).toBeUndefined();
    expect(api.onToolRequest).toBeTypeOf('function');
    expect(api.onToolApprovalStatus).toBeTypeOf('function');
    api.abortTask();
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('task:abort');
    expect(electron.ipcRenderer.send.mock.calls.some(([channel])=>channel==='tool:approve')).toBe(false);
  });
});
