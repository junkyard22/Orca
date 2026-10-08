import { redactValue } from '@clawde/orca-core';

/** Always redact persisted execution audits, including nonstandard configured keys. */
export function serializeExecutionAudit(value:unknown,secrets:string[]=[]):string {
  const known=[...new Set(secrets)].filter(Boolean).sort((a,b)=>b.length-a.length);
  const mask=(entry:unknown):unknown=>{
    if(typeof entry==='string')return known.reduce((text,secret)=>text.replaceAll(secret,'[REDACTED]'),entry);
    if(Array.isArray(entry))return entry.map(mask);
    if(entry&&typeof entry==='object')return Object.fromEntries(Object.entries(entry).map(([key,item])=>[key,mask(item)]));
    return entry;
  };
  return JSON.stringify(mask(redactValue(value)),null,2);
}
