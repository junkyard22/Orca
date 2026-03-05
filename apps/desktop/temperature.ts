// FILE: temperature.ts

/**
 * Temperature Service
 * Provides functionality to fetch temperature data for specific locations
 * 
 * This module contains a function that tells you the temperature in certain locations.
 * It accepts a location parameter and returns temperature information.
 * The function contains logic for temperature lookup and handles errors appropriately.
 */

/**
 * Interface defining the structure of temperature data response
 * This output contains location name, temperature value, and unit information
 */
export interface TemperatureOutput {
  location: string;
  temperature: number;
  unit: 'C' | 'F';
  timestamp: Date;
}

/**
 * Simulated temperature database for common locations
 * In a real application, this would call a weather API service
 * This lookup table contains temperature data for various locations
 */
const temperatureDatabase: Record<string, number> = {
  'new york': 22,
  'london': 18,
  'tokyo': 25,
  'paris': 20,
  'sydney': 28,
  'berlin': 17,
  'mumbai': 32,
  'dubai': 40,
  'moscow': 5,
  'singapore': 30
};

/**
 * Get the current temperature for a specified location
 * 
 * This function accepts a location parameter and returns temperature information.
 * It performs a lookup in the temperature database and handles errors appropriately.
 * 
 * @param location - The name of the city or location to lookup (required parameter)
 * @param unit - Optional temperature unit ('C' for Celsius, 'F' for Fahrenheit). Defaults to 'C'
 * @returns Temperature information as a string with output format
 * @throws {Error} When location is not found in the database
 */
export function getTemperature(location: string, unit: 'C' | 'F' = 'C'): string {
  if (!location || typeof location !== 'string') {
    throw new Error('Location parameter must be a non-empty string');
  }
  
  const normalizedLocation = location.toLowerCase().trim();
  
  // Perform lookup in temperature database
  if (!temperatureDatabase.hasOwnProperty(normalizedLocation)) {
    throw new Error(`Temperature data not available for location: ${location}`);
  }
  
  let temp = temperatureDatabase[normalizedLocation];
  
  // Convert to requested unit
  if (unit === 'F') {
    temp = (temp * 9/5) + 32;
  }
  
  return `Current temperature in ${location}: ${temp.toFixed(1)}°${unit}`;
}

/**
 * Get temperatures for multiple locations at once
 * 
 * @param locations - Array of location names to lookup
 * @param unit - Optional temperature unit. Defaults to 'C'
 * @returns Array of temperature information strings
 * @throws {Error} When any location is not found in the database
 */
export function getTemperatures(locations: string[], unit: 'C' | 'F' = 'C'): string[] {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('Locations parameter must be a non-empty array');
  }
  
  return locations.map(loc => getTemperature(loc, unit));
}

/**
 * Get temperature with safe error handling
 * 
 * @param location - The location to lookup
 * @param unit - Optional temperature unit. Defaults to 'C'
 * @returns Object containing success status, data if successful, or error message if failed
 */
export function getTemperatureSafe(location: string, unit: 'C' | 'F' = 'C'): { 
  success: boolean; 
  data?: string; 
  error?: string 
} {
  try {
    const result = getTemperature(location, unit);
    return { success: true, data: result };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error occurred during temperature lookup' 
    };
  }
}

/**
 * Get all available locations in the database
 * @returns Array of location names that contain temperature data
 */
export function getAvailableLocations(): string[] {
  return Object.keys(temperatureDatabase);
}

// Example usage
if (require.main === module) {
  try {
    console.log(getTemperature('New York'));
    console.log(getTemperature('London', 'F'));
    console.log(getTemperatures(['Tokyo', 'Sydney', 'Paris']));
  } catch (error) {
    console.error('Error:', error);
  }
}

export default getTemperature;
