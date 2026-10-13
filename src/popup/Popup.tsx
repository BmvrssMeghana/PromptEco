import React, { useState, useEffect, useRef } from 'react';
import { Leaf, BarChart3, History, LayoutTemplate, Settings as SettingsIcon, Copy, Check, Trash2, ArrowUpRight, Radio, ClipboardCopy } from 'lucide-react';
import { getStats, getSettings, saveSettings, getActivityHistory, clearAllData, AggregateStats, PromptEcoSettings, ActivityEntry } from '../storage/storage';
import { EMISSION_PRESETS, formatCarbon } from '../engine/carbon';
import { optimizePrompt, OptimizationResult } from '../engine/optimizer';

// ── Prompt Templates for efficient AI prompting ──────────────────────────────
const PROMPT_TEMPLATES = [
  {
    id: 'code-review',
    label: 'Code Review',
    emoji: '🔍',
    category: 'Development',
    template: 'Review this [LANGUAGE] code for bugs, performance issues, and best practices. Explain each issue and suggest fixes:\n\n[PASTE CODE HERE]'
  },
  {
    id: 'debug',
    label: 'Debug Error',
    emoji: '🐛',
    category: 'Development',
    template: 'Debug this [LANGUAGE] error. My code:\n\n[PASTE CODE]\n\nError message:\n[PASTE ERROR]\n\nExplain the cause and provide a fix.'
  },
  {
    id: 'summarize',
    label: 'Summarize',
    emoji: '📝',
    category: 'Writing',
    template: 'Summarize the following in 3 concise bullet points, focusing on the key insights:\n\n[PASTE TEXT]'
  },
  {
    id: 'explain',
    label: 'Explain Concept',
    emoji: '💡',
    category: 'Learning',
    template: 'Explain [CONCEPT] in simple terms with 2 concrete real-world examples. Assume no prior background.'
  },
  {
    id: 'rewrite',
    label: 'Rewrite / Improve',
    emoji: '✍️',
    category: 'Writing',
    template: 'Rewrite the following for a [AUDIENCE] audience in a [TONE] tone. Keep the core message intact:\n\n[PASTE TEXT]'
  },
  {
    id: 'compare',
    label: 'Compare Options',
    emoji: '⚖️',
    category: 'Analysis',
    template: 'Compare [OPTION A] vs [OPTION B] across these criteria: [CRITERIA]. Provide a recommendation at the end.'
  },
  {
    id: 'plan',
    label: 'Action Plan',
    emoji: '🗺️',
    category: 'Planning',
    template: 'Create a step-by-step action plan to [GOAL]. Include timeline, required resources, and potential blockers for each step.'
  },
  {
    id: 'email',
    label: 'Draft Email',
    emoji: '📧',
    category: 'Writing',
    template: 'Draft a [FORMAL/CASUAL] email to [RECIPIENT] about [TOPIC]. Tone: professional but friendly. Keep it under 150 words.'
  }
];

interface PopupProps {
  pagePrompt?: string;
  onInsertToPage?: (text: string) => void;
}

export const Popup: React.FC<PopupProps> = ({ pagePrompt, onInsertToPage }) => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history' | 'templates' | 'settings'>('dashboard');
  const [stats, setStats] = useState<AggregateStats | null>(null);
  const [settings, setSettings] = useState<PromptEcoSettings | null>(null);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  
  // Single Unified Input State (no pre-seeded/mock data)
  const [promptInput, setPromptInput] = useState(pagePrompt || '');
  const [isUserEdited, setIsUserEdited] = useState(false);
  const [testResult, setTestResult] = useState<OptimizationResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [pushedToPage, setPushedToPage] = useState(false);
  const [connectedSource, setConnectedSource] = useState<string>(pagePrompt ? 'Connected to Page' : 'Detecting AI page...');
  const isInputFocusedRef = useRef(false);

  // Sync if pagePrompt prop changes
  useEffect(() => {
    if (pagePrompt !== undefined && !isInputFocusedRef.current && !isUserEdited) {
      setPromptInput(pagePrompt);
      if (pagePrompt.trim()) {
        setConnectedSource('Live from Active Composer');
      }
    }
  }, [pagePrompt, isUserEdited]);

  useEffect(() => {
    loadData();
    detectLivePromptFromActiveTab();

    // Storage change listener — fires whenever content script writes a new prompt
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.prompteco_live_prompt) {
        const newText = changes.prompteco_live_prompt.newValue || '';
        if (!isInputFocusedRef.current && !isUserEdited) {
          setPromptInput(newText);
          if (newText.trim()) setConnectedSource('Live · ' + (changes.prompteco_live_origin?.newValue || 'AI site'));
        }
      }
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(storageListener);
    }

    // Polling fallback: re-query active tab every 2 seconds so the panel stays in sync
    // even if the storage event doesn't fire (e.g. same-value writes)
    const pollInterval = setInterval(() => {
      if (!isInputFocusedRef.current && !isUserEdited) {
        detectLivePromptFromActiveTab();
      }
    }, 2000);

    return () => {
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(storageListener);
      }
      clearInterval(pollInterval);
    };
  }, [isUserEdited]);

  // Live optimization recalculation on any input change
  useEffect(() => {
    if (promptInput.trim()) {
      const res = optimizePrompt(promptInput, settings?.emissionPresetId || 'global_average');
      setTestResult(res);
    } else {
      setTestResult(null);
    }
  }, [promptInput, settings?.emissionPresetId]);

  const detectLivePromptFromActiveTab = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (activeTab?.id) {
          chrome.tabs.sendMessage(activeTab.id, { type: 'GET_ACTIVE_COMPOSER_TEXT' }, (response) => {
            if (chrome.runtime.lastError || !response) {
              // Fallback to storage
              checkStorageFallback();
              return;
            }
            if (response.text) {
              setPromptInput(response.text);
              setConnectedSource(`Live from ${formatPlatform(response.platform, response.url)}`);
            } else {
              setConnectedSource(`${formatPlatform(response.platform, response.url)} (Composer empty)`);
            }
          });
        } else {
          checkStorageFallback();
        }
      });
    } else {
      checkStorageFallback();
    }
  };

  const checkStorageFallback = () => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['prompteco_live_prompt', 'prompteco_live_origin'], (res) => {
        if (res.prompteco_live_prompt) {
          setPromptInput(res.prompteco_live_prompt);
          setConnectedSource(`Live from ${res.prompteco_live_origin || 'AI tool'}`);
        } else {
          setConnectedSource('Ready · Type prompt or open ChatGPT/Claude');
        }
      });
    } else {
      setConnectedSource('Local Mode · Live analysis ready');
    }
  };

  const formatPlatform = (platform?: string, url?: string): string => {
    if (platform && platform !== 'general' && platform !== 'unknown') {
      return platform.toUpperCase();
    }
    if (url) {
      try {
        const host = new URL(url).hostname;
        return host.replace(/^www\./, '');
      } catch {
        return 'Active Tab';
      }
    }
    return 'Active Tab';
  };

  const loadData = async () => {
    const s = await getStats();
    const cfg = await getSettings();
    const h = await getActivityHistory();
    setStats(s);
    setSettings(cfg);
    setHistory(h);
  };

  const handleTogglePanel = async (enabled: boolean) => {
    const updated = await saveSettings({ isInlinePanelEnabled: enabled });
    setSettings(updated);
  };

  const handlePresetChange = async (presetId: string) => {
    const updated = await saveSettings({ emissionPresetId: presetId });
    setSettings(updated);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setIsUserEdited(true);
    setPromptInput(e.target.value);
  };

  const handleCopy = async () => {
    if (!testResult) return;
    await navigator.clipboard.writeText(testResult.optimizedPrompt || promptInput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePushToPage = () => {
    if (!testResult) return;
    const textToSend = testResult.optimizedPrompt || promptInput;
    if (onInsertToPage) {
      onInsertToPage(textToSend);
      setPushedToPage(true);
      setTimeout(() => setPushedToPage(false), 2000);
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (activeTab?.id) {
          chrome.tabs.sendMessage(activeTab.id, { type: 'SET_ACTIVE_COMPOSER_TEXT', text: textToSend }, (res) => {
            if (res && res.success) {
              setPushedToPage(true);
              setTimeout(() => setPushedToPage(false), 2000);
            }
          });
        }
      });
    }
  };

  const handleResetData = async () => {
    if (confirm('Reset all PromptEco local statistics and history?')) {
      await clearAllData();
      await loadData();
    }
  };

  return (
    <div className="pe-popup-app">
      {/* Header */}
      <header className="pe-pop-header">
        <div className="pe-pop-brand">
          <div className="pe-pop-logo">
            <Leaf size={16} />
          </div>
          <div className="pe-pop-title-wrap">
            <h1>PromptEco</h1>
            <p>Live AI Assistant · Zero LLM Calls</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: '#10B981', background: '#ECFDF5', padding: '3px 8px', borderRadius: '12px' }}>
            v1.0.0
          </span>
        </div>
      </header>

      {/* Nav Tabs */}
      <nav className="pe-pop-nav">
        <button
          className={`pe-nav-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <BarChart3 size={13} />
          Dashboard
        </button>
        <button
          className={`pe-nav-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          <History size={13} />
          History
        </button>
        <button
          className={`pe-nav-btn ${activeTab === 'templates' ? 'active' : ''}`}
          onClick={() => setActiveTab('templates')}
        >
          <LayoutTemplate size={13} />
          Templates
        </button>
        <button
          className={`pe-nav-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <SettingsIcon size={13} />
          Settings
        </button>
      </nav>

      {/* Main Tab Content */}
      <main className="pe-tab-body">
        {/* DASHBOARD TAB */}
        {activeTab === 'dashboard' && (
          <>
            {/* Live Synchronized Input Box */}
            <div className="pe-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="pe-card-title">
                  <Leaf size={14} color="#10B981" />
                  Live Prompt Optimizer
                </div>
                {/* Live connection badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10.5px', color: '#10B981', fontWeight: 600 }}>
                  <Radio size={11} className="pe-pulse-icon" />
                  <span>{connectedSource}</span>
                </div>
              </div>

              {/* Same Input Box that parses live from website AND allows manual editing */}
              <textarea
                className="pe-tester-input"
                value={promptInput}
                onChange={handleInputChange}
                onFocus={() => { isInputFocusedRef.current = true; }}
                onBlur={() => { isInputFocusedRef.current = false; }}
                rows={3}
                placeholder="Live prompt from ChatGPT, Claude, or type here manually..."
              />

              {testResult && testResult.status !== 'empty' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#4B5563', flexWrap: 'wrap', gap: '4px' }}>
                    <span>Tokens: <strong>{testResult.originalTokens.tokens}</strong> → <strong style={{ color: testResult.impact.tokensSaved > 0 ? '#10B981' : '#111827' }}>{testResult.optimizedTokens.tokens}</strong></span>
                    <span>Reduction: <strong style={{ color: testResult.impact.reductionPercentage > 0 ? '#10B981' : '#4B5563' }}>
                      {testResult.impact.reductionPercentage > 0 ? `-${testResult.impact.reductionPercentage}%` : '0% (No improvement)'}
                    </strong></span>
                    <span>Saved: <strong style={{ color: testResult.impact.tokensSaved > 0 ? '#10B981' : '#4B5563' }}>
                      {testResult.impact.savedMgCO2.toFixed(2)} mg CO₂e
                    </strong></span>
                  </div>

                  {/* Suggestion Card */}
                  <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '8px', padding: '10px 12px', fontSize: '12.5px', lineHeight: '1.45', color: '#111827' }}>
                    <div style={{ fontSize: '10px', color: '#6B7280', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em', marginBottom: '4px' }}>
                      {testResult.status === 'optimized' ? 'Optimized Rewrite' : 'No improvement found'}
                    </div>
                    {testResult.status === 'optimized' ? (
                      <div>{testResult.optimizedPrompt}</div>
                    ) : (
                      <div style={{ color: '#059669', fontWeight: 500 }}>
                      ✓ No improvement found. No safe, meaningful change was identified for this prompt.
                      </div>
                    )}
                  </div>

                  {/* Changes tags */}
                  {testResult.changes.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {testResult.changes.map((ch, idx) => (
                        <span key={idx} style={{ fontSize: '10px', background: '#F3F4F6', color: '#4B5563', padding: '2px 6px', borderRadius: '4px', border: '1px solid #E5E7EB' }}>
                          {ch}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '4px' }}>
                    <span style={{ fontSize: '11px', color: '#6B7280' }}>
                      Task: {testResult.classification.label}
                    </span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={handlePushToPage}
                        style={{ padding: '5px 10px', fontSize: '11px', fontWeight: 600, background: '#F3F4F6', color: '#111827', border: '1px solid #D1D5DB', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                        title="Send optimized prompt into ChatGPT/Claude composer on the active tab"
                      >
                        <ArrowUpRight size={12} />
                        {pushedToPage ? 'Inserted!' : 'Insert in Tab'}
                      </button>
                      <button
                        onClick={handleCopy}
                        style={{ padding: '5px 10px', fontSize: '11px', fontWeight: 600, background: '#111827', color: '#FFFFFF', border: 'none', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Highlights Card */}
            <div className="pe-carbon-highlight-card">
              <div>
                <div className="pe-carbon-highlight-title">Total Emissions Prevented</div>
                <div className="pe-carbon-highlight-val">
                  {formatCarbon(stats?.totalGramsCO2Saved || 0)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '11px', color: '#065F46', fontWeight: 600 }}>Total Tokens Saved</div>
                <div style={{ fontSize: '18px', fontWeight: 800, color: '#047857' }}>
                  {stats?.totalTokensSaved.toLocaleString() || '0'}
                </div>
              </div>
            </div>

            {/* Stats Grid */}
            <div className="pe-stats-grid">
              <div className="pe-stat-card">
                <span className="pe-stat-label">Prompts Analyzed</span>
                <span className="pe-stat-value">{stats?.totalPromptsAnalyzed || 0}</span>
                <span className="pe-stat-sub">Live detected in composer</span>
              </div>
              <div className="pe-stat-card">
                <span className="pe-stat-label">Optimizations Copied</span>
                <span className="pe-stat-value green">{stats?.totalOptimizationsCopied || 0}</span>
                <span className="pe-stat-sub">Used across AI sessions</span>
              </div>
            </div>
          </>
        )}

        {/* HISTORY TAB */}
        {activeTab === 'history' && (
          <div className="pe-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="pe-card-title">Recent Activity</div>
              <span style={{ fontSize: '11px', color: '#6B7280' }}>Local-only log</span>
            </div>

            {history.length === 0 ? (
              <div style={{ padding: '24px 12px', textAlign: 'center', color: '#6B7280', fontSize: '12px' }}>
                No optimization history recorded yet. Start typing in ChatGPT, Claude, or any AI tool to see live results!
              </div>
            ) : (
              <div className="pe-activity-list">
                {history.map((item) => (
                  <div key={item.id} className="pe-activity-item">
                    <div className="pe-activity-left">
                      <span className="pe-activity-cat">{item.category}</span>
                      <span className="pe-activity-time">
                        {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="pe-activity-right">
                      <div style={{ color: '#10B981', fontWeight: 700 }}>
                        -{item.tokensSaved} tok ({item.savedMgCO2.toFixed(1)} mg)
                      </div>
                      <div style={{ fontSize: '10px', color: '#6B7280' }}>
                        {item.originalTokens} → {item.optimizedTokens}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TEMPLATES TAB */}
        {activeTab === 'templates' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '11px', color: '#6B7280', lineHeight: '1.5', padding: '0 2px' }}>
              Copy any template below, paste into ChatGPT / Claude / Gemini, and fill in the <span style={{ background: '#F3F4F6', fontFamily: 'monospace', padding: '1px 4px', borderRadius: '3px', color: '#111827' }}>[PLACEHOLDERS]</span>.
            </div>
            {PROMPT_TEMPLATES.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === 'settings' && (
          <div className="pe-card">
            <div className="pe-card-title">Preferences & Grid Model</div>

            {/* Inline Assistant Toggle */}
            <div className="pe-setting-row">
              <div>
                <div className="pe-setting-label">Inline Assistant Panel</div>
                <div className="pe-setting-desc">Show assistant adjacent to composer on AI sites</div>
              </div>
              <input
                type="checkbox"
                checked={settings?.isInlinePanelEnabled ?? true}
                onChange={(e) => handleTogglePanel(e.target.checked)}
                style={{ cursor: 'pointer', transform: 'scale(1.2)' }}
              />
            </div>

            {/* Emission Preset */}
            <div className="pe-setting-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
              <div>
                <div className="pe-setting-label">Emission Intensity Preset</div>
                <div className="pe-setting-desc">Configurable emission factor (E_token)</div>
              </div>
              <select
                className="pe-select"
                style={{ width: '100%' }}
                value={settings?.emissionPresetId || 'global_average'}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                {Object.values(EMISSION_PRESETS).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.factorGramsPerToken * 1000} mg/tok)
                  </option>
                ))}
              </select>
            </div>

            {/* Reset Data */}
            <div style={{ paddingTop: '10px' }}>
              <button
                onClick={handleResetData}
                style={{ background: '#FEE2E2', border: '1px solid #FECACA', color: '#DC2626', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', width: '100%', justifyContent: 'center' }}
              >
                <Trash2 size={13} />
                Reset Local Statistics
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="pe-pop-footer">
        <span>PromptEco · Privacy-First</span>
        <span>100% Offline Analysis</span>
      </footer>
    </div>
  );
};

// ─── Template Card Component ───────────────────────────────────────────────────
interface TemplateCardProps {
  template: {
    id: string;
    label: string;
    emoji: string;
    category: string;
    template: string;
  };
}

const TemplateCard: React.FC<TemplateCardProps> = ({ template: t }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(t.template);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #E5E7EB',
      borderRadius: '10px',
      padding: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '16px' }}>{t.emoji}</span>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#111827' }}>{t.label}</span>
          <span style={{
            fontSize: '10px',
            fontWeight: 600,
            background: '#F3F4F6',
            color: '#6B7280',
            padding: '2px 6px',
            borderRadius: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.03em'
          }}>
            {t.category}
          </span>
        </div>
        <button
          onClick={handleCopy}
          title="Copy template"
          style={{
            background: copied ? '#ECFDF5' : '#F9FAFB',
            border: `1px solid ${copied ? '#6EE7B7' : '#E5E7EB'}`,
            color: copied ? '#059669' : '#4B5563',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            transition: 'all 0.15s ease',
            flexShrink: 0
          }}
        >
          {copied ? <Check size={11} /> : <ClipboardCopy size={11} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <div style={{
        fontFamily: 'monospace',
        fontSize: '11px',
        lineHeight: '1.6',
        color: '#374151',
        background: '#F9FAFB',
        border: '1px solid #F3F4F6',
        borderRadius: '6px',
        padding: '8px 10px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word'
      }}>
        {t.template.split(/(\[[A-Z\s/]+\])/).map((part, i) =>
          /^\[[A-Z\s/]+\]$/.test(part) ? (
            <span key={i} style={{
              background: '#FEF3C7',
              color: '#92400E',
              borderRadius: '3px',
              padding: '0 2px'
            }}>{part}</span>
          ) : part
        )}
      </div>
    </div>
  );
};
