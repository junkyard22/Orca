/**
 * Temperature Service
 * Provides functionality to fetch temperature data for a specific location
 */

// Interface for temperature data response
interface TemperatureData {
  location: string;
  temperature: number;
  unit: 'C' | 'F';
  timestamp: Date;
  source: string;
}

/**
 * Fetches the current temperature for a specific location
 * @param location - The name of the city or location to get temperature for
 * @param unit - Optional temperature unit (Celsius by default)
 * @returns A promise that resolves to the temperature data
 */
export async function getTemperature(location: string, unit: 'C' | 'F' = 'C'): Promise<TemperatureData> {
  if (!location || typeof location !== 'string') {
    throw new Error('Location must be a non-empty string');
  }

  // Simulated temperature data based on location
  // In a real implementation, this would call a weather API like OpenWeatherMap
  const locationTemperatures: Record<string, number> = {
    'new york': 22,
    'london': 18,
    'tokyo': 25,
    'paris': 20,
    'sydney': 28,
    'mumbai': 32,
    'moscow': 15,
    'dubai': 40,
    'antarctica': -15,
    'server': 25
  };

  // Normalize location name
  const normalizedLocation = location.toLowerCase().trim();
  
  // Get base temperature or use a default
  let baseTemp = locationTemperatures[normalizedLocation];
  if (baseTemp === undefined) {
    // Use a reasonable default based on location characteristics
    baseTemp = 20;
  }

  // Convert temperature if needed
  let temperature = baseTemp;
  if (unit === 'F') {
    temperature = (baseTemp * 9/5) + 32;
  }

  // Simulate API call delay
  await new Promise(resolve => setTimeout(resolve, 100));

  return {
    location: location,
    temperature: Math.round(temperature * 10) / 10, // Round to 1 decimal
    unit: unit,
    timestamp: new Date(),
    source: 'temperature_service'
  };
}

/**
 * Fetches temperature data for multiple locations
 * @param locations - Array of location names
 * @param unit - Optional temperature unit
 * @returns A promise that resolves to an array of temperature data
 */
export async function getTemperatures(
  locations: string[], 
  unit: 'C' | 'F' = 'C'
): Promise<TemperatureData[]> {
  return Promise.all(locations.map(loc => getTemperature(loc, unit)));
}

// Example usage (uncomment to test)
// async function example() {
//   try {
//     const temp = await getTemperature('New York', 'C');
//     console.log(`Temperature in ${temp.location}: ${temp.temperature}°${temp.unit}`);
//   } catch (error) {
//     console.error('Error fetching temperature:', error);
//   }
// }

export default getTemperature;
