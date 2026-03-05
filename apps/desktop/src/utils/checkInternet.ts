/**
 * @file Provides internet connectivity checking functionality
 * @contains Functions for checking internet connection status using multiple methods
 * @includes online/offline event detection, fetch-based connectivity tests, and error handling
 * @author Assistant
 * @version 1.0.0
 */

/**
 * Configuration options for internet connectivity check
 * @contains Options for timeout, URLs to test, and check methods
 * @includes settings for active/passive connectivity testing
 */
export interface InternetCheckOptions {
  /** Timeout in milliseconds for active connectivity tests (default: 5000) */
  timeout?: number;
  
  /** URLs to test for connectivity (default: public reliable endpoints) */
  testUrls?: string[];
  
  /** Whether to use only navigator.onLine for quick check (default: false) */
  quickCheckOnly?: boolean;
  
  /** Number of retry attempts for failed tests (default: 2) */
  maxRetries?: number;
}

/**
 * Result object containing connectivity information
 * @contains connection status, method used, response details, and error information
 * @includes timestamp and detailed connectivity metrics
 */
export interface InternetCheckResult {
  /** Whether internet connection is available */
  isConnected: boolean;
  
  /** Method used to determine connectivity */
  method: 'online-event' | 'fetch-test' | 'fallback';
  
  /** Timestamp of the check */
  timestamp: number;
  
  /** Response time in milliseconds (if applicable) */
  responseTime?: number;
  
  /** Error message if connection failed */
  error?: string;
  
  /** URL that was tested */
  testedUrl?: string;
}

/**
 * Default URLs to test for internet connectivity
 */
const DEFAULT_TEST_URLS = [
  'https://www.google.com',
  'https://www.cloudflare.com',
  'https://www.wikipedia.org'
];

/**
 * Check if browser is online using navigator.onLine
 */
function checkOnlineStatus(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

/**
 * Perform an active connectivity test using fetch
 * @param url - URL to test connectivity
 * @param timeout - Timeout in milliseconds
 * @returns Promise with connectivity result
 */
async function testConnectivityWithFetch(url: string, timeout: number): Promise<{ success: boolean; responseTime?: number; error?: string }> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  const startTime = performance.now();
  
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      signal: controller.signal,
      cache: 'no-store'
    });
    
    const responseTime = performance.now() - startTime;
    clearTimeout(id);
    
    // With no-cors mode, we can't check response status directly
    // A successful fetch without abort means we're connected
    return { success: true, responseTime };
  } catch (error) {
    clearTimeout(id);
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { success: false, error: 'Connection timeout' };
      }
      return { success: false, error: error.message };
    }
    
    return { success: false, error: String(error) };
  }
}

/**
 * Check internet connectivity with multiple fallback methods
 * @param options - Configuration options
 * @returns Promise resolving to connectivity result
 * @description This function provides robust internet connectivity checking
 * using multiple methods: online event detection, fetch-based tests, and fallback logic
 * @example
 * ```ts
 * // Basic connectivity check
 * const result = await checkInternetConnection();
 * if (result.isConnected) {
 *   console.log('Internet is available!');
 * }
 * 
 * // With custom options
 * const result = await checkInternetConnection({
 *   timeout: 3000,
 *   quickCheckOnly: false,
 *   maxRetries: 3
 * });
 * ```
 */
export async function checkInternetConnection(options: InternetCheckOptions = {}): Promise<InternetCheckResult> {
  const {
    timeout = 5000,
    testUrls = DEFAULT_TEST_URLS,
    quickCheckOnly = false,
    maxRetries = 2
  } = options;

  const result: InternetCheckResult = {
    isConnected: false,
    method: 'fallback',
    timestamp: Date.now()
  };

  // Step 1: Quick check using online status
  if (checkOnlineStatus()) {
    result.method = 'online-event';
    result.isConnected = true;
    
    // If quick check is sufficient, return early
    if (quickCheckOnly) {
      return result;
    }
    
    // Otherwise, verify with active test
  } else {
    result.method = 'online-event';
    result.isConnected = false;
    result.error = 'Offline mode detected';
    return result;
  }

  // Step 2: Active connectivity test
  for (const url of testUrls) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const testResult = await testConnectivityWithFetch(url, timeout);
        
        if (testResult.success) {
          result.isConnected = true;
          result.method = 'fetch-test';
          result.responseTime = testResult.responseTime;
          result.testedUrl = url;
          return result;
        }
      } catch (error) {
        // Continue to next URL or retry
      }
    }
  }

  // Step 3: Fallback - if we got here, active tests failed
  result.isConnected = false;
  result.error = 'Failed to reach any test URLs';
  
  return result;
}

/**
 * Check internet connectivity synchronously (quick check only)
 * @returns Boolean indicating basic connectivity status
 * @description Uses navigator.onLine for immediate result without network calls
 * @example
 * ```ts
 * if (isOnline()) {
 *   // Proceed with online operations
 *   loadData();
 * }
 * ```
 */
export function isOnline(): boolean {
  return checkOnlineStatus();
}

/**
 * Watch for connectivity changes using online/offline events
 * @param callback - Function to call when connectivity changes
 * @returns Unsubscribe function to stop watching
 * @description Sets up event listeners for online/offline events
 * @example
 * ```ts
 * const unsubscribe = watchConnectivity((isConnected) => {
 *   console.log('Connection status:', isConnected ? 'Online' : 'Offline');
 * });
 * 
 * // Later, to stop watching:
 * unsubscribe();
 * ```
 */
export function watchConnectivity(callback: (isConnected: boolean) => void): () => void {
  // Initial call with current status
  callback(checkOnlineStatus());

  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}

export default checkInternetConnection;
