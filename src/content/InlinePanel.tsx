import React, { useState, useEffect } from 'react';
import { Leaf, Copy, Check, ChevronDown, ChevronUp, Sparkles, ArrowRight, ShieldCheck, Info, X } from 'lucide-react';
import { OptimizationResult } from '../engine/optimizer';
import { recordOptimizationUsage } from '../storage/storage';
import './inline.css';

interface InlinePanelProps {
  analysis: OptimizationResult | null;
  onInsertToComposer?: (text: string) => void;
  onDismiss?: () => void;
}

export const InlinePanel: React.FC<InlinePanelProps> = ({
  analysis,
  onInsertToComposer,
  onDismiss
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<'optimized' | 'template'>('optimized');
  const [copied, setCopied] = useState(false);
  const [editableText, setEditableText] = useState('');

  // Sync editable text when analysis updates
  useEffect(() => {
    if (!analysis) return;
    if (activeTab === 'optimized') {
      setEditableText(analysis.optimizedPrompt || analysis.originalPrompt);
    } else {
      setEditableText(analysis.templateSuggestion.filledPrompt);
    }
  }, [analysis, activeTab]);

  if (!analysis || analysis.status === 'empty') {
    return null;
  }

  const {
    originalPrompt,
    optimizedPrompt,
    status,
    changes,
    originalTokens,
    optimizedTokens,
    impact,
    classification,
    templateSuggestion
  } = analysis;

  const handleCopy = async () => {
    try {
      const textToCopy = editableText || (activeTab === 'optimized' ? optimizedPrompt : templateSuggestion.filledPrompt);
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);

      // Record aggregate usage locally
      recordOptimizationUsage({
        originalTokens: originalTokens.tokens,
        optimizedTokens: optimizedTokens.tokens,
        tokensSaved: impact.tokensSaved,
        savedGramsCO2: impact.savedGramsCO2,
        category: classification.label,
        rawPrompt: originalPrompt,
        wasCopied: true
      });
    } catch (err) {
      console.error('Failed to copy to clipboard', err);
    }
  };

  const handleInsert = () => {
    const textToInsert = editableText || (activeTab === 'optimized' ? optimizedPrompt : templateSuggestion.filledPrompt);
    if (onInsertToComposer) {
      onInsertToComposer(textToInsert);
    }
  };

  // Render Mini Collapsed bar
  if (isCollapsed) {
    return (
      <div className="prompteco-container">
        <div className="prompteco-collapsed-bar" onClick={() => setIsCollapsed(false)}>
          <div className="prompteco-brand">
            <span className="prompteco-logo-icon">
              <Leaf size={12} />
            </span>
            <span className="prompteco-title">PromptEco</span>
            {impact.tokensSaved > 0 ? (
              <span className="prompteco-badge prompteco-badge-eco">
                -{impact.reductionPercentage}% tokens ({impact.tokensSaved} saved)
              </span>
            ) : (
              <span className="prompteco-badge">Prompt active ({originalTokens.tokens} tok)</span>
            )}
          </div>
          <div className="prompteco-actions">
            <span className="prompteco-icon-btn" title="Expand panel">
              <ChevronDown size={14} />
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prompteco-container" id="prompteco-inline-root">
      <div className="prompteco-card">
        {/* Header */}
        <div className="prompteco-header">
          <div className="prompteco-brand">
            <span className="prompteco-logo-icon">
              <Leaf size={13} />
            </span>
            <span className="prompteco-title">PromptEco</span>
            <span className="prompteco-badge">Local analysis · No extra AI calls</span>
          </div>
          <div className="prompteco-actions">
            <button
              className="prompteco-icon-btn"
              onClick={() => setIsCollapsed(true)}
              title="Minimize panel"
              aria-label="Minimize"
            >
              <ChevronUp size={14} />
            </button>
            {onDismiss && (
              <button
                className="prompteco-icon-btn"
                onClick={onDismiss}
                title="Dismiss panel"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="prompteco-body">
          {/* Token Count Comparison Metrics */}
          <div className="prompteco-metrics-grid">
            <div className="prompteco-metric-box">
              <div className="prompteco-metric-label">
                <span>Original tokens</span>
                <span className="prompteco-badge" title="Calculated locally via cl100k BPE">
                  {originalTokens.isEstimate ? 'Estimate' : 'Local BPE'}
                </span>
              </div>
              <div className="prompteco-metric-value">
                {originalTokens.tokens}
              </div>
            </div>

            <div className="prompteco-metric-box">
              <div className="prompteco-metric-label">
                <span>Optimized tokens</span>
                <span className="prompteco-badge prompteco-badge-eco" title="Modeled reduction">
                  {status === 'optimized' ? `-${impact.reductionPercentage}%` : 'Optimal'}
                </span>
              </div>
              <div className={`prompteco-metric-value ${impact.tokensSaved > 0 ? 'highlight-green' : ''}`}>
                {activeTab === 'optimized' ? optimizedTokens.tokens : 'Structured'}
              </div>
            </div>
          </div>

          {/* Tab Selector: Rule-based optimization vs Task template */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              className={`prompteco-btn ${activeTab === 'optimized' ? 'prompteco-btn-primary' : 'prompteco-btn-secondary'}`}
              onClick={() => setActiveTab('optimized')}
              style={{ padding: '4px 10px', fontSize: '11px' }}
            >
              <Sparkles size={12} />
              Optimized suggestion
            </button>
            <button
              className={`prompteco-btn ${activeTab === 'template' ? 'prompteco-btn-primary' : 'prompteco-btn-secondary'}`}
              onClick={() => setActiveTab('template')}
              style={{ padding: '4px 10px', fontSize: '11px' }}
            >
              Task Template ({classification.label})
            </button>
          </div>

          {/* Suggestion Card */}
          {status === 'unchanged' && activeTab === 'optimized' ? (
            <div className="prompteco-unchanged-state">
              <ShieldCheck size={16} color="#10B981" />
              <div>
                <strong>Prompt is already concise and optimal!</strong> No safe rule reduced tokens without altering your instructions.
              </div>
            </div>
          ) : (
            <div className="prompteco-suggestion-card">
              <textarea
                className="prompteco-suggestion-text"
                value={editableText}
                onChange={(e) => setEditableText(e.target.value)}
                rows={2}
                placeholder="Optimized prompt..."
                aria-label="Optimized prompt suggestion"
              />

              <div className="prompteco-suggestion-footer">
                <div className="prompteco-disclaimer">
                  <Info size={11} />
                  <span>Review before using · Editable</span>
                </div>

                <div className="prompteco-cta-group">
                  {onInsertToComposer && (
                    <button
                      className="prompteco-btn prompteco-btn-secondary"
                      onClick={handleInsert}
                      title="Insert directly into ChatGPT composer"
                    >
                      <ArrowRight size={12} />
                      Insert
                    </button>
                  )}
                  <button
                    className={`prompteco-btn ${copied ? 'prompteco-btn-success' : 'prompteco-btn-primary'}`}
                    onClick={handleCopy}
                    id="prompteco-copy-btn"
                  >
                    {copied ? (
                      <>
                        <Check size={12} />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        Copy prompt
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Environmental Impact Comparison Banner */}
          <div className="prompteco-impact-banner">
            <div className="prompteco-impact-item">
              <span className="prompteco-impact-label">Token reduction</span>
              <span className="prompteco-impact-num green">
                {impact.reductionPercentage > 0 ? `${impact.reductionPercentage}% reduction` : '0% (Already concise)'}
              </span>
            </div>

            <div className="prompteco-impact-item">
              <span className="prompteco-impact-label">Carbon savings</span>
              <span className="prompteco-impact-num green">
                {impact.tokensSaved > 0
                  ? `${impact.savedMgCO2.toFixed(2)} mg CO₂e saved`
                  : 'Zero waste'}
              </span>
            </div>

            {impact.equivalents.phoneChargeMinutes > 0 && (
              <div className="prompteco-impact-item" style={{ display: 'none' }}>
                <span className="prompteco-impact-label">Equivalence</span>
                <span className="prompteco-impact-num">
                  +{impact.equivalents.phoneChargeMinutes}m phone charge
                </span>
              </div>
            )}
          </div>

          {/* Changes and Preserved Constraints tags */}
          {changes.length > 0 && activeTab === 'optimized' && (
            <div className="prompteco-tags-row">
              <span style={{ fontSize: '11px', color: 'var(--pe-text-muted)', fontWeight: 600 }}>Applied:</span>
              {changes.map((ch, idx) => (
                <span key={idx} className="prompteco-tag">
                  {ch}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
