import { createRoot, Root } from 'react-dom/client';
import { findComposerElement, readComposerText, writeComposerText, ComposerElementInfo, detectPlatform } from './composer-detector';
import { optimizePrompt, OptimizationResult } from '../engine/optimizer';
import { InlinePanel } from './InlinePanel';
import { getSettings } from '../storage/storage';
import './inline.css';

let currentRoot: Root | null = null;
let currentMountEl: HTMLElement | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeComposer: ComposerElementInfo | null = null;
let lastAnalyzedText = '';
let observerActive = false;

/**
 * Broadcasts the current prompt text to chrome.storage.local
 * so the side panel / popup can read it live.
 */
function broadcastLivePrompt(text: string) {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({
      prompteco_live_prompt: text,
      prompteco_live_url: window.location.href,
      prompteco_live_origin: window.location.hostname,
      prompteco_live_platform: detectPlatform(),
      prompteco_live_timestamp: Date.now()
    });
  }
}

/**
 * Renders (or clears) the inline panel next to the AI composer
 */
function renderPanel(analysis: OptimizationResult | null) {
  if (!currentRoot) return;
  currentRoot.render(
    <InlinePanel
      analysis={analysis}
      onInsertToComposer={(newText) => {
        if (activeComposer) {
          writeComposerText(activeComposer, newText);
          handleInputChange(newText, 'global_average');
        }
      }}
      onDismiss={() => {
        if (currentRoot) currentRoot.render(null);
      }}
    />
  );
}

/**
 * Called whenever the composer text changes.
 * Updates broadcast AND runs the optimizer.
 */
function handleInputChange(text: string, emissionPresetId: string, shouldRenderPanel = true) {
  const trimmed = text.trim();
  broadcastLivePrompt(trimmed);

  if (trimmed === lastAnalyzedText) return;
  lastAnalyzedText = trimmed;

  if (!shouldRenderPanel) return;
  if (!trimmed) { renderPanel(null); return; }

  const result = optimizePrompt(trimmed, emissionPresetId);
  renderPanel(result);
}

/**
 * Creates the mount point for the PromptEco inline panel
 */
function setupMountPoint(composer: ComposerElementInfo) {
  // Remove old mount if present
  if (currentMountEl && currentMountEl.parentElement) {
    currentMountEl.parentElement.removeChild(currentMountEl);
    currentMountEl = null;
  }
  if (currentRoot) {
    currentRoot.unmount();
    currentRoot = null;
  }

  const mount = document.createElement('div');
  mount.id = 'prompteco-anchor';
  mount.className = 'prompteco-anchor-wrap';

  // Insert BEFORE the composer container (above the input box)
  const targetParent = composer.containerElement.parentElement;
  if (targetParent) {
    targetParent.insertBefore(mount, composer.containerElement);
  } else {
    composer.containerElement.prepend(mount);
  }

  currentMountEl = mount;
  currentRoot = createRoot(mount);
}

/**
 * Attaches input event listeners to the composer element
 */
function attachInputListeners(
  composer: ComposerElementInfo,
  debounceMs: number,
  emissionPresetId: string,
  renderInline: boolean
) {
  const fireChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const text = readComposerText(composer);
      handleInputChange(text, emissionPresetId, renderInline);
    }, debounceMs);
  };

  composer.inputElement.addEventListener('input', fireChange);
  composer.inputElement.addEventListener('keyup', fireChange);
  composer.inputElement.addEventListener('paste', () => setTimeout(fireChange, 50));
  composer.inputElement.addEventListener('compositionend', fireChange);

  // Fire immediately if text already present on attach
  const existing = readComposerText(composer);
  if (existing.trim()) fireChange();
}

/**
 * Checks if the composer exists and attaches PromptEco if it hasn't already
 */
async function checkAndAttach(debounceMs: number, emissionPresetId: string, renderInline: boolean) {
  const found = findComposerElement();
  if (!found) return;

  // Already attached to this element — skip
  if (activeComposer?.inputElement === found.inputElement) return;

  console.log('[PromptEco] Composer detected on', found.platform, '—', found.inputElement.tagName);
  activeComposer = found;

  if (renderInline) {
    setupMountPoint(found);
  }
  attachInputListeners(found, debounceMs, emissionPresetId, renderInline);
}

/**
 * Main entry point
 */
async function initPromptEco() {
  const settings = await getSettings();

  // Message handler: popup → content script
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request.type === 'GET_ACTIVE_COMPOSER_TEXT') {
        const found = findComposerElement();
        const text = found ? readComposerText(found) : lastAnalyzedText;
        sendResponse({
          text,
          url: window.location.href,
          platform: found?.platform || detectPlatform()
        });
        return true;
      }

      if (request.type === 'SET_ACTIVE_COMPOSER_TEXT') {
        const found = findComposerElement();
        if (found && typeof request.text === 'string') {
          writeComposerText(found, request.text);
          handleInputChange(request.text, settings.emissionPresetId || 'global_average');
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, reason: 'Composer not found' });
        }
        return true;
      }
    });
  }

  const renderInline = settings.isInlinePanelEnabled !== false;
  const debounceMs = settings.debounceMs || 400;
  const emissionPresetId = settings.emissionPresetId || 'global_average';

  // Initial attach attempt
  await checkAndAttach(debounceMs, emissionPresetId, renderInline);

  // MutationObserver: re-check whenever DOM changes (SPA navigation, lazy loading)
  if (!observerActive) {
    observerActive = true;
    let mutationDebounce: ReturnType<typeof setTimeout> | null = null;

    const observer = new MutationObserver(() => {
      if (mutationDebounce) clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => {
        checkAndAttach(debounceMs, emissionPresetId, renderInline);
      }, 300);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
  }

  // Periodic check: safety net in case MutationObserver misses the element
  // (some SPAs do full re-renders that swap out the exact element reference)
  setInterval(() => {
    const found = findComposerElement();
    if (!found) return;
    if (activeComposer?.inputElement !== found.inputElement) {
      // Composer element was replaced — re-attach
      activeComposer = null;
      checkAndAttach(debounceMs, emissionPresetId, renderInline);
    } else if (activeComposer) {
      // Same element — just broadcast current value
      const text = readComposerText(activeComposer);
      if (text.trim() !== lastAnalyzedText) {
        handleInputChange(text, emissionPresetId, false); // broadcast only, don't re-render
      }
    }
  }, 1500);
}

// Bootstrap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPromptEco);
} else {
  initPromptEco();
}
