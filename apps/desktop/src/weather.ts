// Weather utility using Open-Meteo API (no API key required)
// Returns current temperature for a given location

export interface WeatherLocation {
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
}

export interface TemperatureResult {
  ok: boolean;
  temperatureC?: number;
  temperatureF?: number;
  location?: WeatherLocation;
  unit: 'C' | 'F';
  error?: string;
}

/**
 * Get current temperature for a specific location using Open-Meteo API
 * @param location - Object containing latitude and longitude parameters
 * @returns TemperatureResult with current temperature output
 */
export async function getTemperature(location: WeatherLocation): Promise<TemperatureResult> {
  try {
    // Open-Meteo Weather API endpoint
    const url = `https://api.open-meteo.com/v1/forecast`;
    
    // Request parameters - accepts latitude and longitude
    const params = new URLSearchParams({
      latitude: location.latitude.toString(),
      longitude: location.longitude.toString(),
      current_weather: 'true'
    });
    
    // Fetching temperature data from the API
    const response = await fetch(`${url}?${params.toString()}`);
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.current_weather) {
      throw new Error('No weather data available for this location');
    }
    
    const tempC = data.current_weather.temperature;
    const tempF = (tempC * 9/5) + 32;
    
    return {
      ok: true,
      temperatureC: tempC,
      temperatureF: tempF,
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        city: location.city,
        region: location.region,
        country: location.country
      },
      unit: 'C'
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      error: errorMessage,
      unit: 'C'
    };
  }
}

/**
 * Get temperature by city name using Nominatim (OpenStreetMap) for geocoding
 * @param cityName - Name of the city parameter
 * @returns TemperatureResult with current temperature output
 */
export async function getTemperatureByCity(cityName: string): Promise<TemperatureResult> {
  try {
    // First, geocode the city name to get coordinates
    const geocodeUrl = `https://nominatim.openstreetmap.org/search`;
    const geocodeParams = new URLSearchParams({
      q: cityName,
      format: 'json',
      limit: '1'
    });
    
    const geocodeResponse = await fetch(`${geocodeUrl}?${geocodeParams.toString()}`, {
      headers: {
        'User-Agent': 'Orca-Desktop-App/1.0'
      }
    });
    
    if (!geocodeResponse.ok) {
      throw new Error(`Geocoding failed: ${geocodeResponse.status}`);
    }
    
    const geocodeData = await geocodeResponse.json();
    
    if (!geocodeData || geocodeData.length === 0) {
      return {
        ok: false,
        error: `Could not find location: ${cityName}`,
        unit: 'C'
      };
    }
    
    const location = geocodeData[0];
    
    // Then get weather for those coordinates
    return getTemperature({
      latitude: parseFloat(location.lat),
      longitude: parseFloat(location.lon),
      city: location.display_name.split(',')[0],
      region: location.address?.state,
      country: location.address?.country
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      error: errorMessage,
      unit: 'C'
    };
  }
}

/**
 * Get temperature by ZIP/postal code
 * @param zipCode - ZIP or postal code parameter
 * @param country - Country code (optional)
 * @returns TemperatureResult with current temperature output
 */
export async function getTemperatureByZip(zipCode: string, country?: string): Promise<TemperatureResult> {
  const cityName = country ? `${zipCode}, ${country}` : zipCode;
  return getTemperatureByCity(cityName);
}

/**
 * Get temperature by IP address (auto-detection)
 * @returns TemperatureResult with current temperature output
 */
export async function getTemperatureByIP(): Promise<TemperatureResult> {
  try {
    // Get IP location
    const locationResponse = await fetch('https://ipapi.co/json/');
    
    if (!locationResponse.ok) {
      throw new Error(`Location detection failed: ${locationResponse.status}`);
    }
    
    const locationData = await locationResponse.json();
    
    return getTemperature({
      latitude: locationData.latitude,
      longitude: locationData.longitude,
      city: locationData.city,
      region: locationData.region,
      country: locationData.country_name
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      error: errorMessage,
      unit: 'C'
    };
  }
}

// Export utility functions for testing and validation
export const weatherUtils = {
  formatLocation: (loc: WeatherLocation): string => {
    const parts = [loc.city, loc.region, loc.country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : `(${loc.latitude}, ${loc.longitude})`;
  },
  convertToCelsius: (tempF: number): number => (tempF - 32) * 5/9,
  convertToFahrenheit: (tempC: number): number => (tempC * 9/5) + 32
};
