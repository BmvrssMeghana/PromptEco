import { findComposerElement, readComposerText, writeComposerText, ComposerElementInfo, detectPlatform } from './composer-detector';
import { getSettings } from '../storage/storage';

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

/** Remove cards injected by older PromptEco builds from already-open AI pages. */
function removeLegacyInlinePanel() {
  document.querySelectorAll('#prompteco-anchor, #prompteco-inline-root, .prompteco-anchor-wrap, .prompteco-container')
    .forEach((element) => element.remove());
}

/**
 * Called whenever the composer text changes.
 * Broadcasts the current composer value to the existing extension side panel.
 */
function handleInputChange(text: string, force = false) {
  const trimmed = text.trim();
  broadcastLivePrompt(trimmed);

  if (trimmed === lastAnalyzedText && !force) return;
  lastAnalyzedText = trimmed;
}

/**
 * Attaches input event listeners to the composer element
 */
function attachInputListeners(
  composer: ComposerElementInfo,
  debounceMs: number
) {
  const fireChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (activeComposer?.inputElement !== composer.inputElement) return;
      const text = readComposerText(composer);
      handleInputChange(text);
    }, debounceMs);
  };

  composer.inputElement.addEventListener('input', fireChange);
  composer.inputElement.addEventListener('keyup', fireChange);
  composer.inputElement.addEventListener('paste', fireChange);
  composer.inputElement.addEventListener('compositionend', fireChange);
  composer.inputElement.addEventListener('change', fireChange);

  // Fire immediately if text already present on attach
  const existing = readComposerText(composer);
  handleInputChange(existing, true);
}

/**
 * Checks if the composer exists and attaches PromptEco if it hasn't already
 */
async function checkAndAttach(debounceMs: number) {
  const found = findComposerElement();
  if (!found) {
    if (activeComposer) {
      activeComposer = null;
      lastAnalyzedText = '';
      if (debounceTimer) clearTimeout(debounceTimer);
      handleInputChange('', true);
    }
    return;
  }

  // Already attached to this element — skip
  if (activeComposer?.inputElement === found.inputElement) return;

  console.log('[PromptEco] Composer detected on', found.platform, '—', found.inputElement.tagName);
  if (debounceTimer) clearTimeout(debounceTimer);
  lastAnalyzedText = '';
  activeComposer = found;

  attachInputListeners(found, debounceMs);
}

/**
 * Main entry point
 */
async function initPromptEco() {
  // Live analysis now belongs in the browser side panel; clear old in-page cards
  // when a page is visited with the updated extension.
  removeLegacyInlinePanel();
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
          handleInputChange(request.text, true);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, reason: 'Composer not found' });
        }
        return true;
      }
    });
  }

  const debounceMs = settings.debounceMs || 400;

  // Initial attach attempt
  await checkAndAttach(debounceMs);

  // MutationObserver: re-check whenever DOM changes (SPA navigation, lazy loading)
  if (!observerActive) {
    observerActive = true;
    let mutationDebounce: ReturnType<typeof setTimeout> | null = null;

    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !!target;
      });
      if (!relevant) return;
      if (mutationDebounce) clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => {
        void checkAndAttach(debounceMs).then(() => {
          if (activeComposer) {
            handleInputChange(readComposerText(activeComposer));
          }
        });
      }, debounceMs);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: true
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
      checkAndAttach(debounceMs);
    } else if (activeComposer) {
      // Same element — just broadcast current value
      const text = readComposerText(activeComposer);
      if (text.trim() !== lastAnalyzedText) {
        handleInputChange(text, true);
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
