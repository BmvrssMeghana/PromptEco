/**
 * PromptEco Local Storage Service
 * Manages user preferences and local aggregate metrics using chrome.storage.local
 * with automatic fallback to localStorage for web previews/development.
 * Conforms to SRS Section 8 (Privacy: No remote telemetry, no prompt retention by default).
 */

export interface PromptEcoSettings {
  emissionPresetId: string;
  isInlinePanelEnabled: boolean;
  debounceMs: number;
  privacyStorePrompts: boolean;
}

export interface AggregateStats {
  totalPromptsAnalyzed: number;
  totalTokensAnalyzed: number;
  totalTokensSaved: number;
  totalGramsCO2Saved: number;
  totalOptimizationsCopied: number;
  lastActiveTimestamp: number;
}

export interface ActivityEntry {
  id: string;
  timestamp: number;
  category: string;
  originalTokens: number;
  optimizedTokens: number;
  tokensSaved: number;
  savedMgCO2: number;
  // Only stored if privacyStorePrompts is explicitly enabled by user
  promptSnippet?: string;
}

const DEFAULT_SETTINGS: PromptEcoSettings = {
  emissionPresetId: 'global_average',
  isInlinePanelEnabled: true,
  debounceMs: 300,
  privacyStorePrompts: false
};

const DEFAULT_STATS: AggregateStats = {
  totalPromptsAnalyzed: 0,
  totalTokensAnalyzed: 0,
  totalTokensSaved: 0,
  totalGramsCO2Saved: 0,
  totalOptimizationsCopied: 0,
  lastActiveTimestamp: Date.now()
};

const SETTINGS_KEY = 'prompteco_settings';
const STATS_KEY = 'prompteco_stats';
const ACTIVITY_KEY = 'prompteco_activity';

// Helper to detect chrome.storage.local
const isChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

export async function getSettings(): Promise<PromptEcoSettings> {
  if (isChromeStorage) {
    return new Promise((resolve) => {
      chrome.storage.local.get([SETTINGS_KEY], (res) => {
        resolve({ ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) });
      });
    });
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Partial<PromptEcoSettings>): Promise<PromptEcoSettings> {
  const current = await getSettings();
  const updated = { ...current, ...settings };
  if (isChromeStorage) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SETTINGS_KEY]: updated }, () => resolve(updated));
    });
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('Storage save failed', e);
  }
  return updated;
}

export async function getStats(): Promise<AggregateStats> {
  if (isChromeStorage) {
    return new Promise((resolve) => {
      chrome.storage.local.get([STATS_KEY], (res) => {
        resolve({ ...DEFAULT_STATS, ...(res[STATS_KEY] || {}) });
      });
    });
  }
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw ? { ...DEFAULT_STATS, ...JSON.parse(raw) } : DEFAULT_STATS;
  } catch {
    return DEFAULT_STATS;
  }
}

export async function recordOptimizationUsage(params: {
  originalTokens: number;
  optimizedTokens: number;
  tokensSaved: number;
  savedGramsCO2: number;
  category: string;
  rawPrompt?: string;
  wasCopied?: boolean;
}): Promise<AggregateStats> {
  const currentStats = await getStats();
  const settings = await getSettings();

  const updatedStats: AggregateStats = {
    totalPromptsAnalyzed: currentStats.totalPromptsAnalyzed + 1,
    totalTokensAnalyzed: currentStats.totalTokensAnalyzed + params.originalTokens,
    totalTokensSaved: currentStats.totalTokensSaved + params.tokensSaved,
    totalGramsCO2Saved: currentStats.totalGramsCO2Saved + params.savedGramsCO2,
    totalOptimizationsCopied: currentStats.totalOptimizationsCopied + (params.wasCopied ? 1 : 0),
    lastActiveTimestamp: Date.now()
  };

  const activityItem: ActivityEntry = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: Date.now(),
    category: params.category,
    originalTokens: params.originalTokens,
    optimizedTokens: params.optimizedTokens,
    tokensSaved: params.tokensSaved,
    savedMgCO2: params.savedGramsCO2 * 1000,
    ...(settings.privacyStorePrompts && params.rawPrompt
      ? { promptSnippet: params.rawPrompt.slice(0, 60) + (params.rawPrompt.length > 60 ? '...' : '') }
      : {})
  };

  // Get and prepend to recent activity (keep last 50)
  const currentActivity = await getActivityHistory();
  const updatedActivity = [activityItem, ...currentActivity].slice(0, 50);

  if (isChromeStorage) {
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({
        [STATS_KEY]: updatedStats,
        [ACTIVITY_KEY]: updatedActivity
      }, () => resolve());
    });
  } else {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(updatedStats));
      localStorage.setItem(ACTIVITY_KEY, JSON.stringify(updatedActivity));
    } catch (e) {
      console.warn('LocalStorage write error', e);
    }
  }

  return updatedStats;
}

export async function getActivityHistory(): Promise<ActivityEntry[]> {
  if (isChromeStorage) {
    return new Promise((resolve) => {
      chrome.storage.local.get([ACTIVITY_KEY], (res) => {
        resolve(res[ACTIVITY_KEY] || []);
      });
    });
  }
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function clearAllData(): Promise<void> {
  if (isChromeStorage) {
    return new Promise((resolve) => {
      chrome.storage.local.clear(() => resolve());
    });
  }
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(STATS_KEY);
  localStorage.removeItem(ACTIVITY_KEY);
}
