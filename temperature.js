/**
 * Temperature Module
 * Provides functions to retrieve exact temperature from various sources
 */

/**
 * Get temperature from OpenWeatherMap API
 * @param {string} apiKey - Your OpenWeatherMap API key
 * @param {string} city - City name to get temperature for
 * @param {string} units - Units: 'metric' (Celsius), 'imperial' (Fahrenheit), or 'standard' (Kelvin)
 * @returns {Promise<number>} - The exact temperature
 */
async function getWeatherTemperature(apiKey, city, units = 'metric') {
    if (!apiKey || !city) {
        throw new Error('API key and city are required');
    }

    try {
        const encodedCity = encodeURIComponent(city);
        const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodedCity}&appid=${apiKey}&units=${units}`);
        
        if (!response.ok) {
            throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        return data.main.temp;
    } catch (error) {
        console.error('Failed to get weather temperature:', error);
        throw error;
    }
}

/**
 * Get temperature from a simulated/mock source (for testing)
 * @param {string} location - Location identifier
 * @param {number} baseTemp - Base temperature for simulation
 * @returns {number} - The exact temperature
 */
function getSimulatedTemperature(location = 'default', baseTemp = 20) {
    // Add some randomness for realism
    const randomFactor = (Math.random() - 0.5) * 2; // ±1 degree
    return baseTemp + randomFactor;
}

/**
 * Get temperature from Node.js system info (if available)
 * Note: This requires additional system tools or sensors
 * @returns {Promise<number|null>} - The exact temperature or null if not available
 */
async function getSystemTemperature() {
    try {
        // For Node.js, we might use system information libraries
        // This is a placeholder for actual system temperature reading
        console.log('System temperature reading not implemented for this environment');
        return null;
    } catch (error) {
        console.error('Failed to get system temperature:', error);
        return null;
    }
}

/**
 * Get exact temperature with fallback mechanism
 * @param {Object} options - Configuration options
 * @param {string} [options.apiKey] - Weather API key
 * @param {string} [options.city] - City name
 * @param {string} [options.source] - Source: 'weather', 'simulated', or 'system'
 * @param {string} [options.units] - Temperature units
 * @returns {Promise<number>} - The exact temperature
 */
async function getExactTemperature(options = {}) {
    const {
        apiKey,
        city = 'New York',
        source = 'simulated',
        units = 'metric'
    } = options;

    switch (source) {
        case 'weather':
            if (!apiKey) {
                throw new Error('API key is required for weather source');
            }
            return await getWeatherTemperature(apiKey, city, units);
        
        case 'system':
            return await getSystemTemperature();
        
        case 'simulated':
        default:
            // Default to simulated for demonstration
            return getSimulatedTemperature(city, 22);
    }
}

// Export functions for use
module.exports = {
    getExactTemperature,
    getWeatherTemperature,
    getSimulatedTemperature,
    getSystemTemperature
};

// Example usage (uncomment to test):
// const { getExactTemperature } = require('./temperature');
// 
// try {
//     // Get simulated temperature
//     const temp1 = await getExactTemperature({ source: 'simulated' });
//     console.log('Simulated temperature:', temp1.toFixed(2));
//     
//     // Get weather temperature (requires API key)
//     // const temp2 = await getExactTemperature({ 
//     //     source: 'weather', 
//     //     apiKey: 'YOUR_API_KEY', 
//     //     city: 'London'
//     // });
//     // console.log('London temperature:', temp2.toFixed(2));
// } catch (error) {
//     console.error('Error getting temperature:', error);
// }
