import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTemperature, getTemperatureByCity, getTemperatureByIP, weatherUtils } from "./weather";

describe("weather", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns temperatures in both Celsius and Fahrenheit on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ current_weather: { temperature: 20 } }),
    });

    const result = await getTemperature({ latitude: 40.7128, longitude: -74.006, city: "New York" });

    expect(result).toEqual({
      ok: true,
      temperatureC: 20,
      temperatureF: 68,
      location: {
        latitude: 40.7128,
        longitude: -74.006,
        city: "New York",
        region: undefined,
        country: undefined,
      },
      unit: "C",
    });
  });

  it("returns a clear error when geocoding cannot find a city", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const result = await getTemperatureByCity("Atlantis");

    expect(result).toEqual({
      ok: false,
      error: "Could not find location: Atlantis",
      unit: "C",
    });
  });

  it("chains IP lookup into weather lookup", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          latitude: 47.6062,
          longitude: -122.3321,
          city: "Seattle",
          region: "Washington",
          country_name: "United States",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ current_weather: { temperature: 12 } }),
      });

    const result = await getTemperatureByIP();

    expect(result.ok).toBe(true);
    expect(result.temperatureC).toBe(12);
    expect(result.temperatureF).toBeCloseTo(53.6, 5);
    expect(result.location).toEqual({
      latitude: 47.6062,
      longitude: -122.3321,
      city: "Seattle",
      region: "Washington",
      country: "United States",
    });
  });

  it("formats locations and converts units consistently", () => {
    expect(
      weatherUtils.formatLocation({
        latitude: 40.7128,
        longitude: -74.006,
        city: "New York",
        region: "New York",
        country: "United States",
      }),
    ).toBe("New York, New York, United States");

    expect(weatherUtils.convertToFahrenheit(20)).toBe(68);
    expect(weatherUtils.convertToCelsius(68)).toBe(20);
  });
});
