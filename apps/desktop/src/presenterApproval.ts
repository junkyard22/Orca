import { randomUUID } from 'node:crypto';

export type ApprovalOutcome='approved'|'denied'|'timeout'|'cancelled'|'unavailable';
export interface PresenterApprovalHost {
  visible():boolean;
  // The trusted main process owns this native dialog. No renderer approval IPC.
  show(tool:string,args:Record<string,unknown>,signal:AbortSignal):Promise<'approved'|'denied'|'stop'>;
  notify(id:string,tool:string,args:Record<string,unknown>,outcome?:ApprovalOutcome):void;
  stop(reason:string):void;
}
export class PresenterApprovals {
  readonly events:Array<{at:string;id:string;tool:string;outcome:ApprovalOutcome|'pending'}>=[];
  private queue:Promise<void>=Promise.resolve();
  private epoch=0;
  private pending=new Map<string,(outcome:ApprovalOutcome)=>void>();
  constructor(private host:PresenterApprovalHost,private timeoutMs=60_000){}
  cancel():void {this.epoch++;for(const finish of this.pending.values())finish('cancelled');this.queue=Promise.resolve();}
  request(tool:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<boolean>{
    const epoch=this.epoch;
    const result=this.queue.then(()=>epoch===this.epoch&&!signal?.aborted?this.single(tool,args,signal):false);
    this.queue=result.then(()=>undefined,()=>undefined);
    return result;
  }
  private single(tool:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<boolean>{
    if(!this.host.visible()){this.host.stop('Presenter approval unavailable: application is not visible.');return Promise.resolve(false);}
    return new Promise(resolve=>{
      const id=randomUUID();const display=new AbortController();let finished=false;
      const onAbort=()=>finish('cancelled');
      const finish=(outcome:ApprovalOutcome)=>{
        if (outcome==='approved'&&!this.host.visible()) outcome='unavailable';
        if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);this.pending.delete(id);display.abort();
        this.events.push({at:new Date().toISOString(),id,tool,outcome});
        this.host.notify(id,tool,args,outcome);
        if(outcome!=='approved'&&outcome!=='cancelled')this.host.stop(`Presenter approval ${outcome}: ${tool}. Command did not execute.`);
        resolve(outcome==='approved'&&!signal?.aborted);
      };
      const timer=setTimeout(()=>finish('timeout'),this.timeoutMs);
      this.pending.set(id,finish);signal?.addEventListener('abort',onAbort,{once:true});
      this.events.push({at:new Date().toISOString(),id,tool,outcome:'pending'});
      this.host.notify(id,tool,args);
      if(signal?.aborted){finish('cancelled');return;}
      void this.host.show(tool,args,display.signal).then(decision=>{
        if (finished) return;
        if (decision==='stop') {
          this.host.stop(`Stopped by presenter during approval: ${tool}. Command did not execute.`);
          finish('cancelled');
        } else finish(decision==='approved'?'approved':'denied');
      },()=>finish('unavailable'));
    });
  }
}

export function assertManualLiveWindow(state:{visible:boolean;focused:boolean;debugging:boolean}):void{
  if(!state.visible||!state.focused||state.debugging)throw new Error('Live Demo requires manual initiation from the visible, focused application with debugging automation disabled.');
}
