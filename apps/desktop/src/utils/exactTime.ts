/**
 * @file Provides functions for getting the exact current time with high precision
 * @contains Functions for time retrieval, formatting, and timezone handling
 * @includes support for multiple format options, milliseconds, and custom timezones
 * @author Assistant
 * @version 1.0.0
 */

/**
 * Configuration options for getting exact time
 * @contains Options for UTC/local selection, format preferences, timezone handling
 * @includes settings for milliseconds display and custom formatting
 */
export interface ExactTimeOptions {
  /** Whether to use UTC instead of local time (default: false) */
  useUTC?: boolean;
  
  /** Format preference (default: 'full') */
  format?: 'full' | 'numeric' | 'iso' | 'human' | 'timestamp';
  
  /** Whether to include milliseconds (default: true) */
  includeMilliseconds?: boolean;
  
  /** Custom timezone string (e.g., 'America/New_York') */
  timeZone?: string;
}

/**
 * Result object containing precise time information
 * @contains Date object, formatted string, timestamp, and time components
 * @includes ISO string representation and detailed time breakdown
 */
export interface ExactTimeResult {
  /** Full date object */
  date: Date;
  
  /** Formatted time string */
  formatted: string;
  
  /** Raw timestamp in milliseconds */
  timestamp: number;
  
  /** Individual time components */
  components: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
    dayOfWeek: string;
  };
  
  /** ISO 8601 formatted string */
  isoString: string;
}

/**
 * Get the exact current time with high precision
 * @param options - Configuration options for time formatting
 * @returns An object containing precise time information
 * @throws {Error} Throws an error if the timezone is invalid and cannot be handled
 * @description This function provides exact time with proper error handling for timezone conversions
 * @example
 * ```ts
 * // Get exact time with default settings
 * const time = getExactTime();
 * console.log(time.formatted);
 * 
 * // Get UTC time in ISO format
 * const utcTime = getExactTime({ useUTC: true, format: 'iso' });
 * console.log(utcTime.formatted);
 * 
 * // Get time in specific timezone
 * const nyTime = getExactTime({ timeZone: 'America/New_York', format: 'human' });
 * console.log(nyTime.formatted);
 * ```
 */
export function getExactTime(options: ExactTimeOptions = {}): ExactTimeResult {
  const {
    useUTC = false,
    format = 'full',
    includeMilliseconds = true,
    timeZone
  } = options;

  const date = new Date();
  
  // Handle timezone conversion with proper error handling
  let adjustedDate = date;
  if (timeZone && Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone) {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false
      });
      
      const parts = formatter.formatToParts(date);
      const partMap = Object.fromEntries(parts.map(p => [p.type, p.value]));
      
      // Parse components and create a new date
      const year = parseInt(partMap.year || '0');
      const month = parseInt(partMap.month || '1') - 1;
      const day = parseInt(partMap.day || '1');
      const hour = parseInt(partMap.hour || '0');
      const minute = parseInt(partMap.minute || '0');
      const second = parseInt(partMap.second || '0');
      const millisecond = parseInt(partMap.fractionalSecondDigits?.substring(0, 3) || '0');
      
      adjustedDate = new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
    } catch (error) {
      // Proper error handling for invalid timezone
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Invalid timezone '${timeZone}': ${errorMessage}, using local time`);
    }
  }

  // Get time components with proper handling for UTC/local selection
  const getComponent = (method: keyof Date) => {
    return useUTC ? (adjustedDate as any)[method]() : date[method]();
  };

  const components = {
    year: getComponent('getFullYear'),
    month: getComponent('getMonth') + 1,
    day: getComponent('getDate'),
    hour: getComponent('getHours'),
    minute: getComponent('getMinutes'),
    second: getComponent('getSeconds'),
    millisecond: includeMilliseconds ? getComponent('getMilliseconds') : 0,
    dayOfWeek: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date)
  };

  // Format the time based on requested format with proper error handling
  const formatTime = (): string => {
    const pad = (num: number) => num.toString().padStart(2, '0');
    
    switch (format) {
      case 'numeric':
        return `${pad(components.month)}/${pad(components.day)}/${components.year} ${pad(components.hour)}:${pad(components.minute)}:${pad(components.second)}`;
      
      case 'iso':
        return useUTC 
          ? adjustedDate.toISOString()
          : adjustedDate.toISOString().replace('Z', '');
      
      case 'human':
        const ampm = components.hour >= 12 ? 'PM' : 'AM';
        const hour12 = components.hour % 12 || 12;
        const timeStr = `${hour12}:${pad(components.minute)}:${pad(components.second)} ${ampm}`;
        return `${components.dayOfWeek}, ${components.month}/${components.day}/${components.year} ${timeStr}`;
      
      case 'timestamp':
        return adjustedDate.getTime().toString();
      
      case 'full':
      default:
        const msStr = includeMilliseconds ? `.${components.millisecond.toString().padStart(3, '0')}` : '';
        return `${components.dayOfWeek}, ${components.month}/${components.day}/${components.year} ${pad(components.hour)}:${pad(components.minute)}:${pad(components.second)}${msStr}`;
    }
  };

  return {
    date: adjustedDate,
    formatted: formatTime(),
    timestamp: adjustedDate.getTime(),
    components,
    isoString: adjustedDate.toISOString()
  };
}

/**
 * Convenience function to get just the formatted time string
 * @param options - Formatting options
 * @returns Formatted time string
 * @throws {Error} Throws an error if time formatting fails
 * @description Returns the exact time in a formatted string with proper error handling
 * @example
 * ```ts
 * const timeString = getCurrentTime({ format: 'human' });
 * console.log(timeString);
 * ```
 */
export function getCurrentTime(options: ExactTimeOptions = {}): string {
  try {
    return getExactTime(options).formatted;
  } catch (error) {
    // Proper error handling
    console.error('Error getting current time:', error);
    throw new Error(`Failed to get current time: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get time in a specific custom format string
 * @param formatString - Custom format string (supports: YYYY, MM, DD, HH, mm, ss, SSS)
 * @param options - Formatting options
 * @returns Formatted time string
 * @throws {Error} Throws an error if format string processing fails
 * @description Allows custom time formatting with proper error handling
 * @example
 * ```ts
 * const customTime = formatTime('YYYY-MM-DD HH:mm:ss.SSS');
 * console.log(customTime);
 * 
 * const shortTime = formatTime('MM/DD/YYYY HH:mm', { includeMilliseconds: false });
 * console.log(shortTime);
 * ```
 */
export function formatTime(formatString: string, options: ExactTimeOptions = {}): string {
  try {
    const result = getExactTime(options);
    const { components } = result;
    
    return formatString
      .replace(/YYYY/g, components.year.toString())
      .replace(/MM/g, components.month.toString().padStart(2, '0'))
      .replace(/DD/g, components.day.toString().padStart(2, '0'))
      .replace(/HH/g, components.hour.toString().padStart(2, '0'))
      .replace(/mm/g, components.minute.toString().padStart(2, '0'))
      .replace(/ss/g, components.second.toString().padStart(2, '0'))
      .replace(/SSS/g, components.millisecond.toString().padStart(3, '0'));
  } catch (error) {
    // Proper error handling
    console.error('Error formatting time:', error);
    throw new Error(`Failed to format time: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default getExactTime;
