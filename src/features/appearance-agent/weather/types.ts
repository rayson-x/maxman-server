export type CityInput = {
  province: string;
  city: string;
};

export type LocalDateRange = {
  startDate: string;
  endDate: string;
};

export type ResolvedWeatherLocation = {
  providerLocationId: string;
  province: string;
  city: string;
  latitude: number;
  longitude: number;
  timeZone: string;
};

export type HistoricalTemperatureDay = {
  date: string;
  tempMinC: number;
  tempMeanC: number;
  tempMaxC: number;
};

export type ForecastTemperatureDay = {
  date: string;
  tempMinC: number;
  tempMaxC: number;
};

export type LiveTemperatureSnapshot = {
  source: string;
  observedAt: string | null;
  currentTempC: number | null;
  apparentTempC: number | null;
  daily: ForecastTemperatureDay[];
};

export type HistoricalTemperatureFile = {
  schemaVersion: 1;
  location: ResolvedWeatherLocation;
  range: LocalDateRange;
  source: string;
  fetchedAt: string;
  daily: HistoricalTemperatureDay[];
};

export type LoadOrRefreshHistoryInput = {
  input: CityInput;
  location: ResolvedWeatherLocation;
  range: LocalDateRange;
  source: string;
  fetchDaily: () => Promise<HistoricalTemperatureDay[]>;
};

export interface HistoricalTemperatureStore {
  loadOrRefresh(
    input: LoadOrRefreshHistoryInput,
  ): Promise<HistoricalTemperatureFile>;
}

export interface WeatherProvider {
  readonly source?: string;
  resolveCity(input: CityInput): Promise<ResolvedWeatherLocation>;
  getHistoricalDaily(
    location: ResolvedWeatherLocation,
    range: LocalDateRange,
  ): Promise<HistoricalTemperatureDay[]>;
  getCurrentAndForecast(
    location: ResolvedWeatherLocation,
    forecastDays: 7 | 10 | 15,
  ): Promise<LiveTemperatureSnapshot>;
}

export type MonthlyTemperatureSummary = {
  month: number;
  typicalLowC: number;
  typicalMeanC: number;
  typicalHighC: number;
  sampleDays: number;
};

export type HistoricalWeatherContext = {
  periodStart: string;
  periodEnd: string;
  coverageRatio: number;
  months: MonthlyTemperatureSummary[];
};

export type LiveWeatherContext = {
  status: "fresh" | "partial" | "unavailable";
  observedAt: string | null;
  currentTempC: number | null;
  apparentTempC: number | null;
  daily: ForecastTemperatureDay[];
};

export type AgentWeatherContext = {
  schemaVersion: 1;
  asOf: string;
  province: string;
  city: string;
  timeZone: string;
  historical: HistoricalWeatherContext | null;
  live: LiveWeatherContext;
  sources: string[];
};

export interface WeatherContextService {
  build(input: CityInput): Promise<AgentWeatherContext>;
}
