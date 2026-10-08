import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommandTool, writeFileTool } from '@yakstacks/workbench-core';
import { DemoFixContract, executeControlledTool, withDemoFixContract } from './demoFixContract';
import { ExecutionBudget, withExecutionBudget } from './executionBudget';
const baselineDir=resolve(__dirname,'../demo/summit-app');
const fixtures=resolve(__dirname,'../../../packages/pappy-core/src/checks/__fixtures__/find-fix');
const fx=(name:string)=>readFileSync(join(fixtures,name),'utf8');
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0)){if(!root.startsWith(join(tmpdir(),'orca-remediation-')))throw new Error('Unsafe test cleanup path');rmSync(root,{recursive:true,force:true});}});
function setup(){const root=mkdtempSync(join(tmpdir(),'orca-remediation-'));roots.push(root);cpSync(baselineDir,root,{recursive:true});return {root,contract:new DemoFixContract(root,baselineDir)};}
const baseline=()=>({ok:false,output:fx('base_npmtest.out'),error:'Command failed with exit code 1',exitCode:1});
const fixed=()=>({ok:true,output:fx('fixed_npmtest.out'),exitCode:0});
const suite={command:'npm test'};
const write={path:'src/bookings.js',content:fx('bookings.fixed.txt')};
const success=async()=>({ok:true,output:'written'});
describe('demo-specific execution ordering',()=>{
  it('blocks source writes before genuine baseline execution without invoking the tool',async()=>{
    const {contract}=setup();const call=vi.fn(success);expect((await contract.execute('write_file',write,call)).ok).toBe(false);expect(call).not.toHaveBeenCalled();
    expect(()=>contract.assertComplete()).toThrow('incomplete');
  });
  it('rejects an already changed workspace before any model request',()=>{
    const {root}=setup();writeFileSync(join(root,'src/bookings.js'),fx('bookings.fixed.txt'));expect(()=>new DemoFixContract(root,baselineDir)).toThrow('Reset Demo');
  });
  it.each([{...baseline(),exitCode:undefined},{ok:false,output:'',error:'Approval timed out'},{ok:true,output:fx('fixed_npmtest.out'),exitCode:0},{...baseline(),output:fx('base_npmtest.out').replaceAll('a meeting can start exactly when the previous one ends (ISSUE.md)','some other failure')}])('does not admit an invalid/denied baseline',async result=>{
    const {contract}=setup();await contract.execute('run_command',suite,async()=>result);const call=vi.fn(success);await contract.execute('write_file',write,call);expect(call).not.toHaveBeenCalled();
  });
  it('records failing names and requires the same complete suite after the last write',async()=>{
    const {contract}=setup();await contract.execute('run_command',suite,async()=>baseline());await contract.execute('write_file',write,success);
    expect(contract.snapshot().baseline?.failedNames).toEqual(['a meeting can start exactly when the previous one ends (ISSUE.md)']);
    expect(contract.snapshot().finalVerified).toBe(false);
    await contract.execute('run_command',suite,async()=>fixed());expect(contract.snapshot().finalVerified).toBe(true);
    expect(()=>contract.assertComplete()).not.toThrow();
    await contract.execute('write_file',write,success);expect(contract.snapshot().finalVerified).toBe(false);
    expect(()=>contract.assertComplete()).toThrow('incomplete');
  });
  it('rejects a passing summary that does not include the original failing name',async()=>{
    const {contract}=setup();await contract.execute('run_command',suite,async()=>baseline());await contract.execute('write_file',write,success);
    const result=await contract.execute('run_command',suite,async()=>({...fixed(),output:fx('fixed_npmtest.out').replaceAll('a meeting can start exactly when the previous one ends (ISSUE.md)','different test')}));
    expect(result.ok).toBe(false);expect(contract.snapshot().finalVerified).toBe(false);
  });
  it('cannot delete, rewrite or weaken original tests or scripts',async()=>{
    const {contract}=setup();await contract.execute('run_command',suite,async()=>baseline());
    for(const [name,path] of [['write_file','test/bookings.test.js'],['write_file','package.json'],['delete_file','src/bookings.js'],['desktop-commander_edit_block','src/bookings.js']]){const call=vi.fn(success);await contract.execute(name!,{path,content:'changed'},call);expect(call).not.toHaveBeenCalled();}
  });
  it('refuses filtered or compound commands as substitute receipts',async()=>{
    const {contract}=setup();const call=vi.fn(async()=>baseline());for(const command of ['npm test -- --test-name-pattern=one','npm test | tail','echo fake && npm test'])await contract.execute('run_command',{command},call);expect(call).not.toHaveBeenCalled();
  });
  it('leaves unrelated tasks free of the demo workflow',async()=>{
    const call=vi.fn(success);await withDemoFixContract(undefined,()=>executeControlledTool('write_file',write,undefined,call));expect(call).toHaveBeenCalledOnce();
  });
  it('prevents new tools and writes after cancellation, even when context omitted its signal',async()=>{
    const c=new AbortController();const {contract}=setup();await contract.execute('run_command',suite,async()=>baseline());const call=vi.fn(success);
    c.abort('cancelled worker');await expect(withExecutionBudget(new ExecutionBudget(3,c.signal),()=>withDemoFixContract(contract,()=>executeControlledTool('write_file',write,undefined,call)))).rejects.toThrow('cancelled worker');expect(call).not.toHaveBeenCalled();
  });
  it('runs the actual original suite, fixes a temp copy, and records 7/1 then 8/0',async()=>{
    const {root,contract}=setup();const ctx={workspaceRoot:root,runId:'offline-regression',requestApproval:async()=>true};
    const before=await contract.execute('run_command',suite,()=>runCommandTool.execute(suite,ctx));expect(before.exitCode).toBe(1);expect(contract.snapshot().baseline).toMatchObject({counts:{total:8,passed:7,failed:1}});
    const source=readFileSync(join(root,'src/bookings.js'),'utf8').replace('first.start <= second.end && second.start <= first.end','first.start < second.end && second.start < first.end');
    const changed=await contract.execute('write_file',{...write,content:source},()=>writeFileTool.execute({...write,content:source},ctx));expect(changed.ok).toBe(true);
    const after=await contract.execute('run_command',suite,()=>runCommandTool.execute(suite,ctx));expect(after.exitCode).toBe(0);expect(contract.snapshot().finalVerified).toBe(true);
    expect(readFileSync(join(root,'test/bookings.test.js'),'utf8')).toBe(readFileSync(join(baselineDir,'test/bookings.test.js'),'utf8'));
  });
});
