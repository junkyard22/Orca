import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFailingTests, parseTestCounts } from '@clawde/orca-core';
import { currentExecutionBudget } from './executionBudget';
import { classifyTool } from './toolAuthorization';

export const FIND_FIX_PRESET = "Users reported a bug in this meeting-room booking app (see ISSUE.md). Investigate the repository, identify the root cause, and implement the smallest correct fix in the source code. Then run the project's test suite and verify that the reported problem is actually resolved. Do not change unrelated behavior or modify the existing tests.";
const ISSUE_TEST = 'a meeting can start exactly when the previous one ends (ISSUE.md)';
type Result = { ok: boolean; output: string; error?: string; exitCode?: number };
const hash = (path:string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ORIGINAL_FILES = ['ISSUE.md','README.md','package.json','test/bookings.test.js','src/bookings.js'];
function checkRegularFiles(root:string):void {
  for (const file of ORIGINAL_FILES) {
    const path=join(root,file);
    if (!lstatSync(path).isFile() || realpathSync(path)!==join(realpathSync(root),file)) throw new Error('Demo contract requires original regular files without redirected paths.');
  }
}
function testNames(output:string): string[] {
  // Only the original node:test suite is in this demonstration's contract.
  return [...output.matchAll(/^(?:(?:ok|not ok) \d+ - |[ \t]*[✔✖] )(.+?)(?: \([\d.]+ ?ms\))?\s*(?:#.*)?$/gm)].map(m=>m[1]!.trim());
}
export class DemoFixContract {
  private readonly protectedHashes: Map<string,string>;
  private readonly sourceHash: string;
  private baseline?: { output:string; failedNames:string[]; allNames:string[]; counts:unknown };
  private generation = 0;
  private verifiedGeneration = -1;
  private queue:Promise<void>=Promise.resolve();
  readonly events: Array<{stage:string;detail:unknown}> = [];
  constructor(readonly root:string, baselineDir:string) {
    const files=ORIGINAL_FILES;
    checkRegularFiles(root);
    for(const file of files) if(hash(join(root,file))!==hash(join(baselineDir,file))) throw new Error('Find & Fix requires Reset Demo: original workspace hashes do not match.');
    this.protectedHashes=new Map(files.filter(f=>f!=='src/bookings.js').map(f=>[f,hash(join(root,f))]));
    this.sourceHash=hash(join(root,'src/bookings.js'));
  }
  private checkProtected():void {
    checkRegularFiles(this.root);
    for(const [file,before] of this.protectedHashes) if(hash(join(this.root,file))!==before) throw new Error(`Demo contract: protected original file changed: ${file}`);
  }
  private record(stage:string,detail:unknown):void { this.events.push({stage,detail}); }
  snapshot() { return { baseline:this.baseline, sourceGeneration:this.generation, finalVerified:this.generation>0&&this.generation===this.verifiedGeneration, events:this.events }; }
  assertComplete():void {
    this.checkProtected();
    if (!this.snapshot().finalVerified) throw new Error('Find & Fix incomplete: original failing tests were not verified passing after the last source write.');
  }
  async execute(name:string,input:Record<string,unknown>,call:()=>Promise<Result>):Promise<Result> {
    const result=this.queue.then(()=>this.executeOne(name,input,call));
    this.queue=result.then(()=>undefined,()=>undefined);
    return result;
  }
  private async executeOne(name:string,input:Record<string,unknown>,call:()=>Promise<Result>):Promise<Result> {
    currentExecutionBudget()?.assertActive();
    this.checkProtected();
    const capability = classifyTool(name);
    const mutates = capability === 'workspace_write' || /(?:write|edit|modify|delete|create|move|rename)/i.test(name);
    if (!['workspace_read','workspace_write','shell_policy'].includes(capability)) return {ok:false,output:'',error:'Demo Find & Fix permits only local inspection, the original suite, and its source correction.'};
    if(mutates) {
      if(!this.baseline) return {ok:false,output:'',error:'Baseline required: execute the original full npm test suite and reproduce its failing test before source writes.'};
      if(name!=='write_file'||typeof input.path!=='string'||resolve(this.root,input.path)!==resolve(this.root,'src/bookings.js')) return {ok:false,output:'',error:'Demo contract permits writes only to src/bookings.js; original tests and project scripts are protected.'};
    }
    const isSuite = name==='run_command'&&input.command==='npm test'&&(input.cwd===undefined||resolve(this.root,String(input.cwd))===resolve(this.root));
    // Arbitrary filtered/test commands cannot substitute for this suite's receipts.
    if(name==='run_command'&&!isSuite) return {ok:false,output:'',error:'Find & Fix requires the exact unfiltered npm test command in the demo root; inspect files with read tools.'};
    if(isSuite&&!this.baseline&&hash(join(this.root,'src/bookings.js'))!==this.sourceHash) throw new Error('Original source changed before baseline reproduction.');
    const result=await call();
    currentExecutionBudget()?.assertActive();
    this.checkProtected();
    if(mutates&&result.ok){this.generation++;this.verifiedGeneration=-1;}
    if(isSuite){
      const counts=parseTestCounts(result.output);
      const failedNames=parseFailingTests(result.output);
      const allNames=testNames(result.output);
      const unskipped=!/^\s*(?:ok|not ok).*#\s*(?:SKIP|TODO)/im.test(result.output)&&!/(?:#|ℹ)\s*(?:skipped|cancelled|todo)\s+[1-9]/i.test(result.output);
      if(!this.baseline){
        if(result.exitCode!==1||result.ok||counts?.total!==8||counts.passed!==7||counts.failed!==1||failedNames.length!==1||failedNames[0]!==ISSUE_TEST||allNames.length!==8||!unskipped||hash(join(this.root,'src/bookings.js'))!==this.sourceHash) return { ...result,ok:false,error:'Baseline execution did not prove the original 7 passing / 1 failing suite with its named failing test.' };
        this.baseline={output:result.output,failedNames,allNames,counts};
        this.record('fix.baseline',this.baseline);
      }else{
        const sameNames=[...allNames].sort().join('\n')===[...this.baseline.allNames].sort().join('\n');
        const allFailedNowPass=this.baseline.failedNames.every(n=>allNames.includes(n)&&!failedNames.includes(n));
        if(result.exitCode===0&&result.ok&&counts?.total===8&&counts.passed===8&&counts.failed===0&&sameNames&&allFailedNowPass&&unskipped&&this.generation>0){
          this.verifiedGeneration=this.generation;
          this.record('fix.final',{counts,previouslyFailingNowPassing:this.baseline.failedNames,allNames,output:result.output,sourceGeneration:this.generation});
        }else return {...result,ok:false,error:'Final execution does not prove all original tests, including the reproduced failure, pass after the last source change.'};
      }
    }
    return result;
  }
}
const contracts=new AsyncLocalStorage<DemoFixContract|undefined>();
export function withDemoFixContract<T>(contract:DemoFixContract|undefined,call:()=>T):T {return contracts.run(contract,call);}
export function currentDemoFixContract(){return contracts.getStore();}
export async function executeControlledTool(name:string,input:Record<string,unknown>,signal:AbortSignal|undefined,call:(signal?:AbortSignal)=>Promise<Result>):Promise<Result>{
  const budget=currentExecutionBudget();
  budget?.assertActive();
  const activeSignal=budget?.signal&&signal?AbortSignal.any([budget.signal,signal]):budget?.signal??signal;
  if(activeSignal?.aborted){const e=new Error('Cancelled before tool execution.');e.name='AbortError';throw e;}
  const contract=contracts.getStore();
  return contract?contract.execute(name,input,()=>call(activeSignal)):call(activeSignal);
}
