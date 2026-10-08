import { describe, expect, it } from 'vitest';
import { serializeExecutionAudit } from './executionAudit';

describe('execution audit persistence',()=>{
  it('does not corrupt numbers, booleans or field names when an environment value is short',()=>{
    expect(JSON.parse(serializeExecutionAudit({budget:3,verified:true,inputTokens:33,output:'true 3 key'},['3','true','key']))).toEqual({budget:3,verified:true,inputTokens:33,output:'[REDACTED] [REDACTED] [REDACTED]'});
  });
  it('redacts known keys and credential patterns while retaining usage and cancellation evidence',()=>{
    const secret='nonstandard-test-key-with-"quote"';
    const audit={budget:{limitUsd:3,spentUsd:2.01,inputTokens:100,outputTokens:10},error:`rejected ${secret}`,authorization:'Bearer test-token',cancellationReason:'Stopped by presenter',output:'sk-ant-test-test-test'};
    const result=JSON.parse(serializeExecutionAudit(audit,[secret]));
    expect(result.budget).toEqual(audit.budget);
    expect(result.error).toBe('rejected [REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.output).toBe('[REDACTED]');
    expect(result.cancellationReason).toBe('Stopped by presenter');
    expect(audit.error).toContain(secret);
  });
});
