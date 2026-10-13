/**
 * PromptEco Composer Detector & Observer
 * Resiliently locates prompt input elements across ChatGPT, Claude, Gemini, DeepSeek,
 * Perplexity, Poe, Microsoft Copilot, and standard AI web interfaces.
 *
 * Uses ordered selector priority — most-specific selectors first.
 */

export interface ComposerElementInfo {
  inputElement: HTMLElement;
  containerElement: HTMLElement;
  isContentEditable: boolean;
  platform: 'chatgpt' | 'claude' | 'gemini' | 'deepseek' | 'perplexity' | 'copilot' | 'general';
}

/**
 * Detects which AI platform the user is currently on
 */
export function detectPlatform(): ComposerElementInfo['platform'] {
  const host = window.location.hostname.toLowerCase();
  if (host.includes('chatgpt') || host.includes('openai')) return 'chatgpt';
  if (host.includes('claude')) return 'claude';
  if (host.includes('gemini') || host.includes('bard')) return 'gemini';
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('perplexity')) return 'perplexity';
  if (host.includes('copilot') || host.includes('bing')) return 'copilot';
  return 'general';
}

// Ordered selectors — most specific / platform-specific first
// Each entry: { selector, isContentEditable }
const ORDERED_SELECTORS: Array<{ sel: string; ce: boolean }> = [
  // ── ChatGPT ───────────────────────────────────────────────────────────────
  { sel: '#prompt-textarea', ce: true },
  { sel: 'div#prompt-textarea[contenteditable="true"]', ce: true },
  { sel: 'textarea[data-testid="prompt-textarea"]', ce: false },
  { sel: 'div[contenteditable="true"][data-placeholder*="message" i]', ce: true },
  { sel: 'div[contenteditable="true"][placeholder*="message" i]', ce: true },

  // ── Claude ────────────────────────────────────────────────────────────────
  { sel: 'div.ProseMirror[contenteditable="true"]', ce: true },
  { sel: 'fieldset div[contenteditable="true"]', ce: true },
  { sel: '[data-testid="chat-input"][contenteditable="true"]', ce: true },
  { sel: 'div[contenteditable="true"].font-claude-message', ce: true },
  { sel: '[class*="claude"] div[contenteditable="true"]', ce: true },

  // ── Gemini ────────────────────────────────────────────────────────────────
  { sel: 'rich-textarea .ql-editor[contenteditable="true"]', ce: true },
  { sel: 'div.ql-editor[contenteditable="true"]', ce: true },
  { sel: 'textarea[aria-label*="prompt" i]', ce: false },
  { sel: 'textarea[aria-label*="Enter a prompt" i]', ce: false },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  { sel: 'textarea#chat-input', ce: false },
  { sel: 'textarea[placeholder*="deepseek" i]', ce: false },

  // ── Perplexity ────────────────────────────────────────────────────────────
  { sel: 'textarea[placeholder*="Ask" i]', ce: false },
  { sel: 'textarea[placeholder*="Search" i]', ce: false },

  // ── Copilot / Bing ────────────────────────────────────────────────────────
  { sel: 'div[contenteditable="true"][aria-label*="chat" i]', ce: true },
  { sel: 'textarea[aria-label*="chat" i]', ce: false },

  // ── Generic AI / Poe / HuggingChat ───────────────────────────────────────
  { sel: 'textarea[placeholder*="Message" i]', ce: false },
  { sel: 'textarea[placeholder*="anything" i]', ce: false },
  { sel: 'textarea[class*="ChatMessageInput"]', ce: false },
  { sel: 'textarea[class*="chat" i]', ce: false },

  // ── Universal fallbacks ───────────────────────────────────────────────────
  { sel: 'main textarea', ce: false },
  { sel: 'form textarea', ce: false },
  { sel: 'div[role="textbox"][contenteditable="true"]', ce: true },
];

/**
 * Checks if an element is actually visible and interactive
 */
function isVisible(el: HTMLElement): boolean {
  if (!el) return false;
  if (el.offsetParent === null && !el.closest('dialog') && !el.closest('[role="dialog"]')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Finds the container to mount the PromptEco panel near
 */
function findContainer(el: HTMLElement): HTMLElement {
  return (
    el.closest('form') as HTMLElement ||
    el.closest('fieldset') as HTMLElement ||
    el.closest('[class*="composer"]') as HTMLElement ||
    el.closest('[class*="input-area"]') as HTMLElement ||
    el.closest('[class*="chat-input"]') as HTMLElement ||
    el.parentElement as HTMLElement ||
    el
  );
}

/**
 * Primary: Find the active prompt input across all supported platforms
 */
export function findComposerElement(): ComposerElementInfo | null {
  const platform = detectPlatform();

  // 1. Try ordered selectors
  for (const { sel, ce } of ORDERED_SELECTORS) {
    try {
      const elements = document.querySelectorAll(sel);
      for (const rawEl of elements) {
        const el = rawEl as HTMLElement;
        if (isVisible(el)) {
          return {
            inputElement: el,
            containerElement: findContainer(el),
            isContentEditable: ce || el.getAttribute('contenteditable') === 'true',
            platform
          };
        }
      }
    } catch {
      // Invalid selector — skip
    }
  }

  // 2. Fall back: currently focused element if it's an input
  const active = document.activeElement as HTMLElement | null;
  if (active && isVisible(active)) {
    const tag = active.tagName;
    const isTextArea = tag === 'TEXTAREA';
    const isCE = active.getAttribute('contenteditable') === 'true';
    if (isTextArea || isCE) {
      return {
        inputElement: active,
        containerElement: findContainer(active),
        isContentEditable: isCE,
        platform
      };
    }
  }

  return null;
}

/**
 * Read text from a composer element (handles both textarea and contenteditable)
 */
export function readComposerText(info: ComposerElementInfo): string {
  if (info.isContentEditable) {
    const text = info.inputElement.innerText;
    return (text && text.trim()) ? text : (info.inputElement.textContent || '');
  }
  return (info.inputElement as HTMLTextAreaElement).value || '';
}

/**
 * Write text into a composer, dispatching React-compatible synthetic events
 * so the SPA frameworks (React, Vue, ProseMirror) actually "see" the change.
 */
export function writeComposerText(info: ComposerElementInfo, newText: string): void {
  const el = info.inputElement;
  el.focus();

  if (info.isContentEditable) {
    // Use execCommand for ProseMirror / Quill compatibility
    document.execCommand('selectAll');
    document.execCommand('insertText', false, newText);

    // Fallback: direct innerText + events
    if (el.innerText !== newText) {
      el.innerText = newText;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Move cursor to end
    const sel = window.getSelection();
    if (sel && el.childNodes.length > 0) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } else {
    const ta = el as HTMLTextAreaElement;
    // React controlled input needs nativeInputValueSetter
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(ta, newText);
    } else {
      ta.value = newText;
    }
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
