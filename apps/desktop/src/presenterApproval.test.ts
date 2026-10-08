import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresenterApprovals, assertManualLiveWindow, type PresenterApprovalHost } from './presenterApproval';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommandTool } from '@yakstacks/workbench-core';
afterEach(()=>vi.useRealTimers());
function host():PresenterApprovalHost{return {visible:()=>true,show:vi.fn(()=>new Promise(()=>{})),notify:vi.fn(),stop:vi.fn()};}
describe('native presenter-only approvals',()=>{
  it('requires a visible, focused app with automation debugging disabled',()=>{
    for(const state of [{visible:false,focused:true,debugging:false},{visible:true,focused:false,debugging:false},{visible:true,focused:true,debugging:true}])expect(()=>assertManualLiveWindow(state)).toThrow('manual initiation');
    expect(()=>assertManualLiveWindow({visible:true,focused:true,debugging:false})).not.toThrow();
  });
  it('never grants a timeout, records it explicitly, closes the dialog and stops the run',async()=>{
    vi.useFakeTimers();const h=host();let signal:AbortSignal|undefined;h.show=vi.fn(async(_t,_a,s)=>{signal=s;return new Promise(()=>{});});const p=new PresenterApprovals(h);const decision=p.request('run_command',{command:'npm test'});
    await vi.advanceTimersByTimeAsync(60_000);expect(await decision).toBe(false);expect(signal?.aborted).toBe(true);expect(h.stop).toHaveBeenCalledWith(expect.stringContaining('timeout'));expect(p.events.at(-1)?.outcome).toBe('timeout');
  });
  it('ignores a late native approval after timeout',async()=>{
    vi.useFakeTimers();const h=host();let respond!:(x:'approved')=>void;h.show=vi.fn(()=>new Promise(r=>respond=r));const p=new PresenterApprovals(h);const decision=p.request('run_command',{});await vi.advanceTimersByTimeAsync(60_000);expect(await decision).toBe(false);respond('approved');await Promise.resolve();expect(p.events.filter(e=>e.outcome==='approved')).toHaveLength(0);
  });
  it('approves only the current native decision, separately for every call',async()=>{
    const h=host();h.show=vi.fn(async()=> 'approved');const p=new PresenterApprovals(h);expect(await p.request('run_command',{command:'npm test'})).toBe(true);expect(await p.request('run_command',{command:'npm test'})).toBe(true);expect(h.show).toHaveBeenCalledTimes(2);
  });
  it('aborts queued and visible approvals immediately on cancellation',async()=>{
    const h=host();const c=new AbortController();const p=new PresenterApprovals(h);const first=p.request('run_command',{},c.signal);const second=p.request('run_command',{},c.signal);await Promise.resolve();c.abort('stopped');p.cancel();expect(await first).toBe(false);expect(await second).toBe(false);expect(h.show).toHaveBeenCalledTimes(1);expect(p.events.at(-1)?.outcome).toBe('cancelled');
  });
  it('refuses approval if the app is hidden and stops instead of waiting silently',async()=>{
    const h=host();h.visible=()=>false;const p=new PresenterApprovals(h);expect(await p.request('run_command',{})).toBe(false);expect(h.show).not.toHaveBeenCalled();expect(h.stop).toHaveBeenCalledWith(expect.stringContaining('not visible'));
  });
  it('treats native failure as an explicit blocking failure',async()=>{
    const h=host();h.show=vi.fn(async()=>{throw new Error('native unavailable');});const p=new PresenterApprovals(h);expect(await p.request('run_command',{})).toBe(false);expect(h.stop).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });
  it('records the presenter Stop choice as cancellation and stops the run',async()=>{
    const h=host();h.show=vi.fn(async()=> 'stop');const p=new PresenterApprovals(h);
    expect(await p.request('run_command',{})).toBe(false);
    expect(h.stop).toHaveBeenCalledWith(expect.stringContaining('Stopped by presenter during approval'));
    expect(p.events.at(-1)?.outcome).toBe('cancelled');
  });
  it('refuses an approval if the app was hidden while the native prompt was pending',async()=>{
    const h=host();h.show=vi.fn(async()=>{h.visible=()=>false;return 'approved';});const p=new PresenterApprovals(h);
    expect(await p.request('run_command',{})).toBe(false);expect(p.events.at(-1)?.outcome).toBe('unavailable');
  });
  it('never launches the real command after presenter approval times out',async()=>{
    vi.useFakeTimers();
    const root=mkdtempSync(join(tmpdir(),'orca-approval-regression-'));
    try {
      const controller=new AbortController();const h=host();
      h.stop=reason=>controller.abort(new Error(reason));
      const p=new PresenterApprovals(h);
      const result=runCommandTool.execute({command:'node -e "require(\'node:fs\').writeFileSync(\'must-not-execute\',\'bad\')"'}, {
        workspaceRoot:root,runId:'offline-approval-regression',abortSignal:controller.signal,
        requestApproval:(tool,args)=>p.request(tool,args,controller.signal),
      }).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await result).error?.message).toContain('approval timeout');
      expect(existsSync(join(root,'must-not-execute'))).toBe(false);
      expect(p.events.at(-1)?.outcome).toBe('timeout');
    } finally {
      if (!root.startsWith(join(tmpdir(),'orca-approval-regression-'))) throw new Error('Unsafe test cleanup');
      rmSync(root,{recursive:true,force:true});
    }
  });
});
