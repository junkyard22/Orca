/**
 * Doctor Core - Foundation Diagnostics Layer
 * 
 * Doctor is NOT a UI feature. Doctor is runtime trust verification.
 * 
 * Phase 1: Extract diagnostic logic from application layer
 * Core diagnostic functions callable from anywhere (main, renderer, CLI)
 * 
 * Original doctor.ts remains for backward compatibility
 * Future: Deprecate original doctor.ts, migrate fully to core
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

// ============================================================================
// TYPES (Core subset - matches doctor.ts for compatibility)
// ============================================================================

export interface DiagnosticResult {
  name: string;
  category: 'system' | 'process' | 'network' | 'security';
  status: 'PASS' | 'WARN' | 'FAIL';
  evidence: string;
  fixSteps?: string[];
  duration?: number;
}

export interface DoctorReport {
  timestamp: string;
  platform: string;
  version: string;
  results: DiagnosticResult[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  trigger?: 'manual' | 'auto';
  triggerReason?: string;
}

// ============================================================================
// CORE DIAGNOSTICS (Pure functions - no state)
// ============================================================================

/**
 * Run all diagnostics
 * Returns structured report with PASS/WARN/FAIL for each check
 */
export async function runDiagnostics(appVersion: string = '2.0.1-dev'): Promise<DoctorReport> {
  const results: DiagnosticResult[] = [];
  
  // System checks
  results.push(checkOSAndArch());
  results.push(checkDiskSpace());
  results.push(checkMemory());
  
  // Process checks
  results.push(await checkProcessSpawn());
  results.push(await checkStdoutStderr());
  
  // Network checks
  results.push(await checkLocalhostBind());
  results.push(checkLoopback());
  
  // Path checks
  results.push(checkPathSanity());
  
  // Platform-specific checks
  if (process.platform === 'win32') {
    results.push(checkWindowsDefender());
  }
  
  // Calculate summary
  const summary = {
    pass: results.filter(r => r.status === 'PASS').length,
    warn: results.filter(r => r.status === 'WARN').length,
    fail: results.filter(r => r.status === 'FAIL').length
  };
  
  return {
    timestamp: new Date().toISOString(),
    platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    version: appVersion,
    results,
    summary,
    trigger: 'manual'
  };
}

/**
 * Check OS and architecture
 */
function checkOSAndArch(): DiagnosticResult {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  
  const supported = ['win32', 'darwin', 'linux'].includes(platform);
  
  return {
    name: 'OS and Architecture',
    category: 'system',
    status: supported ? 'PASS' : 'WARN',
    evidence: `${platform} ${arch} ${release}`,
    fixSteps: supported ? undefined : ['Workbench is designed for Windows, macOS, and Linux']
  };
}

/**
 * Check available disk space
 */
function checkDiskSpace(): DiagnosticResult {
  try {
    const homedir = os.homedir();
    // Simple check - detailed disk space check would need platform-specific code
    const canWrite = fs.existsSync(homedir);
    
    return {
      name: 'Disk Space',
      category: 'system',
      status: canWrite ? 'PASS' : 'WARN',
      evidence: canWrite ? 'Home directory accessible' : 'Cannot access home directory'
    };
  } catch (error: any) {
    return {
      name: 'Disk Space',
      category: 'system',
      status: 'FAIL',
      evidence: error.message,
      fixSteps: ['Check disk permissions']
    };
  }
}

/**
 * Check available memory
 */
function checkMemory(): DiagnosticResult {
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  
  const status = freeMemMB < 500 ? 'WARN' : 'PASS';
  
  return {
    name: 'Memory',
    category: 'system',
    status,
    evidence: `${freeMemMB} MB free of ${totalMemMB} MB`,
    fixSteps: status === 'WARN' ? ['Close unused applications to free memory'] : undefined
  };
}

/**
 * Check process spawn capability
 */
async function checkProcessSpawn(): Promise<DiagnosticResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    try {
      const proc = spawn(process.platform === 'win32' ? 'cmd' : 'sh', 
        process.platform === 'win32' ? ['/c', 'echo test'] : ['-c', 'echo test']
      );
      
      let output = '';
      proc.stdout?.on('data', (data) => { output += data.toString(); });
      
      proc.on('close', (code) => {
        const duration = Date.now() - start;
        resolve({
          name: 'Process Spawn',
          category: 'process',
          status: code === 0 ? 'PASS' : 'FAIL',
          evidence: code === 0 ? 'Can spawn child processes' : `Spawn failed with code ${code}`,
          duration,
          fixSteps: code === 0 ? undefined : ['Check OS permissions for process execution']
        });
      });
      
      proc.on('error', (err) => {
        resolve({
          name: 'Process Spawn',
          category: 'process',
          status: 'FAIL',
          evidence: err.message,
          fixSteps: ['Verify Node.js installation', 'Check system permissions']
        });
      });
    } catch (error: any) {
      resolve({
        name: 'Process Spawn',
        category: 'process',
        status: 'FAIL',
        evidence: error.message,
        fixSteps: ['Verify Node.js installation']
      });
    }
  });
}

/**
 * Check stdout/stderr capture
 */
async function checkStdoutStderr(): Promise<DiagnosticResult> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(process.platform === 'win32' ? 'cmd' : 'sh',
        process.platform === 'win32' ? ['/c', 'echo stdout && echo stderr >&2'] : ['-c', 'echo stdout; echo stderr >&2']
      );
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });
      
      proc.on('close', () => {
        const hasStdout = stdout.includes('stdout');
        const hasStderr = stderr.includes('stderr');
        
        resolve({
          name: 'Stdout/Stderr Capture',
          category: 'process',
          status: (hasStdout && hasStderr) ? 'PASS' : 'WARN',
          evidence: `stdout: ${hasStdout ? 'captured' : 'missing'}, stderr: ${hasStderr ? 'captured' : 'missing'}`,
          fixSteps: !(hasStdout && hasStderr) ? ['Check console/terminal configuration'] : undefined
        });
      });
    } catch (error: any) {
      resolve({
        name: 'Stdout/Stderr Capture',
        category: 'process',
        status: 'FAIL',
        evidence: error.message
      });
    }
  });
}

/**
 * Check localhost bind capability
 */
async function checkLocalhostBind(): Promise<DiagnosticResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.on('error', (err: any) => {
      resolve({
        name: 'Localhost Bind',
        category: 'network',
        status: 'FAIL',
        evidence: err.message,
        fixSteps: ['Check firewall settings', 'Verify no port conflicts']
      });
    });
    
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close();
      resolve({
        name: 'Localhost Bind',
        category: 'network',
        status: 'PASS',
        evidence: `Can bind to 127.0.0.1:${address.port}`
      });
    });
  });
}

/**
 * Check loopback interface
 */
function checkLoopback(): DiagnosticResult {
  const interfaces = os.networkInterfaces();
  const hasLoopback = Object.values(interfaces).some(iface =>
    iface?.some(addr => addr.address === '127.0.0.1' || addr.address === '::1')
  );
  
  return {
    name: 'Loopback Interface',
    category: 'network',
    status: hasLoopback ? 'PASS' : 'FAIL',
    evidence: hasLoopback ? 'Loopback interface present' : 'No loopback interface found',
    fixSteps: hasLoopback ? undefined : ['Check network configuration', 'Restart network services']
  };
}

/**
 * Check PATH sanity
 */
function checkPathSanity(): DiagnosticResult {
  const envPath = process.env.PATH || '';
  const pathEntries = envPath.split(path.delimiter).filter(Boolean);
  
  if (pathEntries.length === 0) {
    return {
      name: 'PATH Environment',
      category: 'system',
      status: 'FAIL',
      evidence: 'PATH is empty',
      fixSteps: ['Check environment configuration', 'Restart application']
    };
  }
  
  return {
    name: 'PATH Environment',
    category: 'system',
    status: 'PASS',
    evidence: `${pathEntries.length} entries in PATH`
  };
}

/**
 * Check Windows Defender (Windows only)
 */
function checkWindowsDefender(): DiagnosticResult {
  if (process.platform !== 'win32') {
    return {
      name: 'Windows Defender',
      category: 'security',
      status: 'PASS',
      evidence: 'Not applicable (not Windows)'
    };
  }
  
  try {
    // Best-effort check - may not always be accurate
    const result = execSync('powershell -Command "Get-MpPreference -ErrorAction SilentlyContinue | Select-Object -ExpandProperty DisableRealtimeMonitoring"', 
      { timeout: 5000, encoding: 'utf-8' }
    );
    
    const disabled = result.trim() === 'True';
    
    return {
      name: 'Windows Defender',
      category: 'security',
      status: 'PASS',
      evidence: disabled ? 'Real-time protection disabled' : 'Real-time protection enabled',
      fixSteps: disabled ? undefined : ['If experiencing slowness, consider adding Workbench to exclusions']
    };
  } catch {
    return {
      name: 'Windows Defender',
      category: 'security',
      status: 'PASS',
      evidence: 'Unable to check (may require admin)',
      fixSteps: ['If experiencing slowness, manually check Defender exclusions']
    };
  }
}
