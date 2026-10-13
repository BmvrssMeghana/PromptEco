import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('live detector covers current ChatGPT and Claude composer variants', async () => {
  const source = await readSource('./composer-detector.ts');
  for (const selector of ['#mobile-composer-prompt', '#prompt-textarea', 'ProseMirror', 'chat-input', 'role="textbox"']) {
    assert.ok(source.includes(selector), `missing composer selector ${selector}`);
  }
  assert.match(source, /active\.isContentEditable/);
  assert.match(source, /isPromptEcoElement\(el\)/);
  assert.match(source, /isPromptEcoElement\(active\)/);
});

test('extension side panel applies empty live composer values instead of retaining stale text', async () => {
  const source = await readSource('../popup/Popup.tsx');
  assert.match(source, /setPromptInput\(response\.text \|\| ''\)/);
  assert.match(source, /setPromptInput\(currentPrompt\)/);
  assert.match(source, /Composer empty/);
});

test('live input changes and DOM edits are debounced into the current analysis', async () => {
  const source = await readSource('./index.tsx');
  for (const event of ['input', 'keyup', 'paste', 'compositionend', 'change']) {
    assert.ok(source.includes(`addEventListener('${event}'`), `missing ${event} listener`);
  }
  assert.match(source, /characterData:\s*true/);
  assert.match(source, /handleInputChange\(readComposerText\(activeComposer\)\)/);
  assert.match(source, /checkAndAttach\(debounceMs\)/);
  assert.match(source, /activeComposer\?\.inputElement !== composer\.inputElement/);
  assert.match(source, /handleInputChange\('', true\)/);
  assert.doesNotMatch(source, /InlinePanel|setupMountPoint|renderPanel/);
});

test('unchanged UI state does not claim optimization or savings', async () => {
  const [panel, popup] = await Promise.all([
    readSource('./InlinePanel.tsx'),
    readSource('../popup/Popup.tsx')
  ]);
  assert.match(panel, /No improvement found/);
  assert.match(popup, /No improvement found/);
  assert.doesNotMatch(panel, /already concise and optimal/i);
  assert.doesNotMatch(popup, /already concise and token-efficient/i);
});
