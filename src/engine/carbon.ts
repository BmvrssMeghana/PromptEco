/**
 * PromptEco Carbon Footprint & Impact Engine
 * Calculates input carbon footprint, token savings, and intuitive environmental equivalents.
 * Follows SRS Section 6: C_input = T_input * E_token
 */

export interface EmissionPreset {
  id: string;
  name: string;
  factorGramsPerToken: number; // E_token (gCO2e per token)
  description: string;
  citation: string;
}

export const EMISSION_PRESETS: Record<string, EmissionPreset> = {
  global_average: {
    id: 'global_average',
    name: 'Global Average Grid (Default)',
    factorGramsPerToken: 0.00030, // 0.3 mg CO2e / token
    description: 'Average data center PUE (1.2-1.4) on standard global electric grid (approx. 400-450 gCO2e/kWh).',
    citation: 'Luccioni et al. (2023), Strubell et al., de Vries (2023) modeled AI inference proxies.'
  },
  hyperscale_efficient: {
    id: 'hyperscale_efficient',
    name: 'Efficient Hyperscale Cloud',
    factorGramsPerToken: 0.00018, // 0.18 mg CO2e / token
    description: 'Modern low-PUE (1.1) hyperscale infrastructure with partial renewable energy purchase agreements.',
    citation: 'Google & Microsoft Environmental Reports (2023-2024).'
  },
  carbon_intensive: {
    id: 'carbon_intensive',
    name: 'Fossil-Heavy Grid',
    factorGramsPerToken: 0.00055, // 0.55 mg CO2e / token
    description: 'Inference hosted in regions with higher coal and natural gas grid generation.',
    citation: 'IEA Global Energy & Emissions Data.'
  },
  renewable_datacenter: {
    id: 'renewable_datacenter',
    name: '100% Renewable Matched',
    factorGramsPerToken: 0.00008, // 0.08 mg CO2e / token
    description: 'Facilities powered by 24/7 carbon-free clean energy (solar/wind/hydro), accounting only for embodied hardware lifecycle emissions.',
    citation: 'Patterson et al. (2021) The Carbon Footprint of Machine Learning Training and Inference.'
  }
};

export interface CarbonAnalysis {
  originalTokens: number;
  optimizedTokens: number;
  tokensSaved: number;
  reductionPercentage: number;
  originalGramsCO2: number;
  optimizedGramsCO2: number;
  savedGramsCO2: number;
  // User-friendly formatted values
  savedMgCO2: number;
  equivalents: {
    phoneChargeMinutes: number; // Equivalent smartphone charging time saved
    ledBulbMinutes: number;     // Equivalent 10W LED bulb illumination time saved
    distanceMeters: number;     // Equivalent meters driven by an electric car (approx 0.08g/m)
  };
  presetUsed: EmissionPreset;
  disclaimer: string;
}

/**
 * Calculates carbon emissions and savings comparing original and optimized token counts.
 */
export function calculateCarbonImpact(
  originalTokens: number,
  optimizedTokens: number,
  presetId = 'global_average'
): CarbonAnalysis {
  const preset = EMISSION_PRESETS[presetId] || EMISSION_PRESETS.global_average;
  const factor = preset.factorGramsPerToken;

  const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
  const reductionPercentage = originalTokens > 0
    ? Math.round(((tokensSaved / originalTokens) * 100) * 10) / 10
    : 0;

  const originalGramsCO2 = originalTokens * factor;
  const optimizedGramsCO2 = optimizedTokens * factor;
  const savedGramsCO2 = tokensSaved * factor;
  const savedMgCO2 = savedGramsCO2 * 1000;

  // Real world equivalents:
  // 1 smartphone full charge ≈ 3.2 gCO2e (~120 minutes of charging) -> ~37.5 min / gCO2e
  const phoneChargeMinutes = Math.round(savedGramsCO2 * 37.5 * 10) / 10;
  // 10W LED bulb for 1 hour ≈ 3.8 gCO2e (~15.8 min / gCO2e)
  const ledBulbMinutes = Math.round(savedGramsCO2 * 15.8 * 10) / 10;
  // 1 meter EV driving ≈ 0.08 gCO2e -> 12.5 meters / gCO2e
  const distanceMeters = Math.round(savedGramsCO2 * 12.5 * 10) / 10;

  return {
    originalTokens,
    optimizedTokens,
    tokensSaved,
    reductionPercentage,
    originalGramsCO2,
    optimizedGramsCO2,
    savedGramsCO2,
    savedMgCO2,
    equivalents: {
      phoneChargeMinutes,
      ledBulbMinutes,
      distanceMeters
    },
    presetUsed: preset,
    disclaimer: 'Calculated input estimate based on modeled data center emission factors. Actual physical emissions vary by server hardware, time of day, and grid mix.'
  };
}

/**
 * Format carbon grams/mg into a human-readable clean string
 */
export function formatCarbon(grams: number): string {
  if (grams === 0) return '0.00 mg CO₂e';
  if (grams < 0.001) {
    const mg = grams * 1000;
    return `${mg.toFixed(2)} mg CO₂e`;
  }
  if (grams < 1) {
    const mg = grams * 1000;
    return `${mg.toFixed(1)} mg CO₂e`;
  }
  return `${grams.toFixed(3)} g CO₂e`;
}
