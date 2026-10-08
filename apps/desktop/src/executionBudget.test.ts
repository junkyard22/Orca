import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatAdapter, createMirandaGate } from '@clawde/miranda-core';
import { createDirectLLMService } from '@clawde/orca-core';
import { budgetedAdapter, ExecutionBudget, withExecutionBudget } from './executionBudget';
import { runGatedLLMCall } from './llmGate';
import type { ProviderEntry } from './settings';

const provider:ProviderEntry={id:'a',name:'Anthropic',type:'anthropic',baseUrl:'https://api.anthropic.com/v1',apiKey:'fake-test-key'};
const model='claude-sonnet-5-5';
const request={model,messages:[{role:'user' as const,content:'hello'}],temperature:0,maxTokens:1000};
const response=(promptTokens=100,completionTokens=10)=>({content:'ok',model,usage:{promptTokens,completionTokens,totalTokens:promptTokens+completionTokens},durationMs:1});
afterEach(()=>vi.unstubAllGlobals());
const frozenTime=new Date('2026-10-08T12:00:00Z');
function ledger(limit=3,signal?:AbortSignal){vi.spyOn(Date,'now').mockReturnValue(frozenTime.getTime());return new ExecutionBudget(limit,signal);}
afterEach(()=>vi.restoreAllMocks());

describe('shared provider-boundary budget ledger',()=>{
  it('reflects the configured cap and conservatively refuses Opus under $3 before a request',async()=>{
    const b=ledger();const call=vi.fn();
    await expect(b.invoke(provider,'claude-opus-5-5',request,call)).rejects.toThrow('cannot reserve');
    expect(call).not.toHaveBeenCalled();expect(b.snapshot().limitUsd).toBe(3);
    expect(b.events.at(-1)?.stage).toBe('budget.blocked');
  });
  it('reserves exposure before dispatch and settles genuine completion usage',async()=>{
    const b=ledger();const call=vi.fn(async r=>{expect(b.snapshot().reservedUsd).toBe(2.01);expect(r.requireUsage).toBe(true);return response();});
    await b.invoke(provider,model,request,call);
    expect(b.snapshot()).toMatchObject({spentUsd:0.0003,reservedUsd:0,uncertainUsd:0,inputTokens:100,outputTokens:10});
  });
  it('counts serial repairs and fallbacks against the same ledger',async()=>{
    const b=ledger(5);const call=vi.fn(async()=>response(100_000,1000));
    await withExecutionBudget(b,async()=>{
      const first=budgetedAdapter({name:'mock',complete:call},provider,model);
      const repair=budgetedAdapter({name:'mock',complete:call},provider,model);
      await first.complete(request);await repair.complete(request);
    });
    expect(b.snapshot()).toMatchObject({spentUsd:0.42,inputTokens:200_000,outputTokens:2000});
  });
  it('cannot oversubscribe the cap with concurrent in-flight requests',async()=>{
    const b=ledger(3);let finish!:(x:ReturnType<typeof response>)=>void;
    const first=b.invoke(provider,model,request,()=>new Promise(r=>finish=r));
    const second=vi.fn(async()=>response());
    await expect(b.invoke(provider,model,request,second)).rejects.toThrow('cannot reserve');
    expect(second).not.toHaveBeenCalled();finish(response());
    await expect(first).rejects.toThrow('cannot reserve');
    expect(b.snapshot().reservedUsd).toBe(0);expect(b.snapshot().spentUsd).toBe(0.0003);
  });
  it.each([null,{promptTokens:0,completionTokens:NaN,totalTokens:0},{promptTokens:10,completionTokens:1,totalTokens:999}])('fails closed on missing or invalid usage: %j',async usage=>{
    const b=ledger();const call=vi.fn(async()=>({...response(),usage}));
    await expect(b.invoke(provider,model,request,call)).rejects.toThrow('usage');
    expect(b.snapshot()).toMatchObject({spentUsd:2.01,uncertainUsd:2.01,reservedUsd:0});
    const retry=vi.fn();await expect(b.invoke(provider,model,request,retry)).rejects.toThrow();expect(retry).not.toHaveBeenCalled();
  });
  it('charges the reservation on a network failure and refuses a fallback',async()=>{
    const b=ledger(20);await expect(b.invoke(provider,model,request,async()=>{throw new Error('disconnected');})).rejects.toThrow('disconnected');
    const fallback=vi.fn();await expect(b.invoke(provider,model,request,fallback)).rejects.toThrow('Usage unavailable');expect(fallback).not.toHaveBeenCalled();
    expect(b.snapshot().uncertainUsd).toBe(2.01);
  });
  it.each(['unpriced-model','anthropic/claude-sonnet-5-5'])('refuses unverified model pricing %s',async unknown=>{
    const call=vi.fn();await expect(ledger().invoke(provider,unknown,request,call)).rejects.toThrow('verified price');expect(call).not.toHaveBeenCalled();
  });
  it('refuses unverified endpoint prices even for a known model ID',async()=>{
    const call=vi.fn();await expect(ledger().invoke({...provider,baseUrl:'https://custom.example/v1'},model,request,call)).rejects.toThrow('verified price');expect(call).not.toHaveBeenCalled();
  });
  it.each(['http://localhost:11434','https://cloud.example'])('does not silently exempt unverified Ollama metering at %s',async baseUrl=>{
    const call=vi.fn();await expect(ledger().invoke({...provider,type:'ollama',baseUrl},'ollama-model',request,call)).rejects.toThrow('metering is not verified');expect(call).not.toHaveBeenCalled();
  });
  it('preserves explicitly unbudgeted provider use without fabricating accounting',async()=>{
    const b=ledger(0);const call=vi.fn(async()=>({...response(),usage:null}));
    await b.invoke({...provider,type:'ollama',baseUrl:'http://localhost:11434'},'local-model',request,call);
    expect(call).toHaveBeenCalledOnce();expect(b.snapshot().limitUsd).toBeNull();
  });
  it('refuses expired prices and invalid output limits before dispatch',async()=>{
    const b=ledger();vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-08T00:00:00Z'));const call=vi.fn();await expect(b.invoke(provider,model,request,call)).rejects.toThrow('verified price');expect(call).not.toHaveBeenCalled();
    const b2=ledger();await expect(b2.invoke(provider,model,{...request,maxTokens:Infinity},call)).rejects.toThrow('token limit');expect(call).not.toHaveBeenCalled();
  });
  it.each([NaN,Infinity,-1])('rejects malformed budget %s',cap=>expect(()=>new ExecutionBudget(cap)).toThrow('Invalid budget'));
  it('refuses unscoped desktop requests without touching transport',async()=>{
    const call=vi.fn();const adapter=budgetedAdapter({name:'mock',complete:call},provider,model);
    expect(()=>adapter.complete(request)).toThrow('No execution budget');expect(call).not.toHaveBeenCalled();
  });
  it('retains uncertain exposure when an in-flight request is cancelled',async()=>{
    const controller=new AbortController();const b=ledger(3,controller.signal);
    await expect(b.invoke(provider,model,request,async r=>{controller.abort(new Error('Presenter stopped'));throw r.signal!.reason;})).rejects.toThrow('Presenter stopped');
    expect(b.snapshot().uncertainUsd).toBe(2.01);const next=vi.fn();await expect(b.invoke(provider,model,request,next)).rejects.toThrow('Presenter stopped');expect(next).not.toHaveBeenCalled();
  });
  it('does not bill calls cancelled before dispatch',async()=>{
    const c=new AbortController();c.abort('planning cancelled');const call=vi.fn();const b=ledger(3,c.signal);
    await expect(b.invoke(provider,model,request,call)).rejects.toThrow('planning cancelled');expect(call).not.toHaveBeenCalled();expect(b.snapshot().spentUsd).toBe(0);
  });
  it('uses real streaming usage, preserves it through direct transport, and traces the finite cap',async()=>{
    const payload='data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"model":"claude-sonnet-5-5","usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\ndata: [DONE]';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(payload)));
    const b=ledger();const trace=vi.fn();
    const svc=createDirectLLMService(budgetedAdapter(new OpenAICompatAdapter({baseUrl:provider.baseUrl,defaultModel:model}),provider,model),model);
    const result=await withExecutionBudget(b,()=>runGatedLLMCall({gate:createMirandaGate(),model,recordTrace:trace},{stage:'worker',outputOf:r=>r.text},()=>svc.stream('hello',{maxTokens:1000},()=>{})));
    expect(result.usage).toEqual({promptTokens:100,completionTokens:10,totalTokens:110});expect(b.snapshot().spentUsd).toBe(0.0003);
    expect(trace).toHaveBeenCalledWith('miranda.before_llm_call',expect.objectContaining({budgetLimit:3,budgetUsed:0}));
    expect(trace).toHaveBeenCalledWith('budget.settled',expect.objectContaining({usage:result.usage}));
  });
  it('never retries a budgeted stream without usage after an HTTP error',async()=>{
    const fetch=vi.fn(async()=>new Response('unsupported field',{status:400}));vi.stubGlobal('fetch',fetch);
    const b=ledger();const a=budgetedAdapter(new OpenAICompatAdapter({baseUrl:provider.baseUrl,defaultModel:model}),provider,model);
    await expect(withExecutionBudget(b,()=>a.stream!(request,()=>{}))).rejects.toThrow('API error 400');expect(fetch).toHaveBeenCalledTimes(1);expect(b.snapshot().uncertainUsd).toBe(2.01);
  });
  it('does not treat SSE chunks as tokens or accept a truncated billed stream',async()=>{
    const fetch=vi.fn(async()=>new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'));vi.stubGlobal('fetch',fetch);
    const b=ledger();const a=budgetedAdapter(new OpenAICompatAdapter({baseUrl:provider.baseUrl,defaultModel:model}),provider,model);
    await expect(withExecutionBudget(b,()=>a.stream!(request,()=>{}))).rejects.toThrow('usage');expect(b.snapshot().uncertainUsd).toBe(2.01);
  });
  it('refuses truncated streams even when an apparently valid usage chunk arrived',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\n')));
    const b=ledger();const a=budgetedAdapter(new OpenAICompatAdapter({baseUrl:provider.baseUrl,defaultModel:model}),provider,model);
    await expect(withExecutionBudget(b,()=>a.stream!(request,()=>{}))).rejects.toThrow('usage');
    expect(b.snapshot()).toMatchObject({reservedUsd:0,spentUsd:2.01,uncertainUsd:2.01});
  });
});
