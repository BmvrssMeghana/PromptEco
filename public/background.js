/**
 * PromptEco Background Service Worker
 * Sets up the Side Panel to open when the extension icon is clicked.
 * The side panel stays open until the user closes it — no more popup that closes on blur.
 */

// Open side panel when extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[PromptEco] Failed to set panel behavior:', error));
