import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { optimizePrompt } from './optimizer.ts';
import { calculateCarbonImpact } from './carbon.ts';

test('optimizes a new educational topic and classifies each actual input', () => {
  const result = optimizePrompt('Could you please explain tidal locking to a beginner?');
  assert.equal(result.status, 'optimized');
  assert.match(result.optimizedPrompt, /tidal locking/i);
  assert.match(result.optimizedPrompt, /beginner/i);
  assert.ok(result.optimizedTokens.tokens < result.originalTokens.tokens);
});

test('preserves coding language, functional requirements, and negation', () => {
  const prompt = 'Could you please implement a TypeScript function that sorts records by createdAt, handles null values, and returns a stable order. Do not use external libraries.';
  const result = optimizePrompt(prompt);
  assert.equal(result.status, 'optimized');
  for (const phrase of ['TypeScript', 'createdAt', 'null values', 'stable order', 'Do not use external libraries']) {
    assert.ok(result.optimizedPrompt.includes(phrase), `missing ${phrase}`);
  }
});

test('compacts professional writing request without losing tone or purpose', () => {
  const result = optimizePrompt('Can you please help me to write a professional email requesting an extension for my assignment submission deadline?');
  assert.match(result.optimizedPrompt, /^Write a professional email/i);
  assert.match(result.optimizedPrompt, /extension/i);
  assert.match(result.optimizedPrompt, /assignment submission deadline/i);
});

test('removes an exact repeated instruction from a long prompt', () => {
  const sentence = 'Explain how ocean acidification affects coral reefs in simple terms.';
  const result = optimizePrompt(`${sentence} Include two examples from the Pacific. ${sentence}`);
  assert.equal(result.optimizedPrompt.toLowerCase().split(sentence.toLowerCase()).length - 1, 1);
  assert.match(result.optimizedPrompt, /two examples from the Pacific/i);
});

test('removes safe introductory request framing', () => {
  const result = optimizePrompt('Please help me to summarize the causes of urban heat islands.');
  assert.equal(result.optimizedPrompt, 'Summarize the causes of urban heat islands.');
});

test('retains negations, quantities, dates, formats, identifiers, and technical terms', () => {
  const prompt = 'Could you please analyze PostgreSQL query plan idx_orders_created_at for 12 records dated 2025-04-03, and return exactly 4 JSON bullet points? Do not use external libraries.';
  const result = optimizePrompt(prompt);
  for (const value of ['PostgreSQL', 'idx_orders_created_at', '12', '2025-04-03', 'exactly 4', 'JSON', 'bullet points', 'Do not use external libraries']) {
    assert.ok(result.optimizedPrompt.toLowerCase().includes(value.toLowerCase()), `missing ${value}`);
  }
});

test('leaves an already concise prompt unchanged', () => {
  const prompt = 'Define entropy in one sentence.';
  const result = optimizePrompt(prompt);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.optimizedPrompt, prompt);
  assert.equal(result.impact.tokensSaved, 0);
  assert.equal(result.impact.reductionPercentage, 0);
});

test('processes unfamiliar subjects without requiring a known prompt match', () => {
  const result = optimizePrompt('Can you please describe the Vela pulsar glitch recovery timescale?');
  assert.equal(result.status, 'optimized');
  assert.match(result.optimizedPrompt, /Vela pulsar glitch recovery timescale/i);
});

test('handles empty input separately', () => {
  const result = optimizePrompt('   ');
  assert.equal(result.status, 'empty');
  assert.equal(result.optimizedPrompt, '');
  assert.equal(result.originalTokens.tokens, 0);
  assert.equal(result.impact.tokensSaved, 0);
});

test('does not make unsafe changes inside code or quoted material', () => {
  const prompt = 'Please explain this exactly: `do not remove this identifier` and preserve the code verbatim.';
  const result = optimizePrompt(prompt);
  assert.equal(result.optimizedPrompt, prompt);
  assert.equal(result.status, 'unchanged');
});

test('does not report savings when a proposed result is longer', () => {
  const impact = calculateCarbonImpact(10, 14);
  assert.equal(impact.tokensSaved, 0);
  assert.equal(impact.reductionPercentage, 0);
  assert.equal(impact.savedGramsCO2, 0);
});

test('recalculates independent results on consecutive different inputs', () => {
  const first = optimizePrompt('Could you please explain basalt weathering?');
  const second = optimizePrompt('Please help me to list 3 causes of aurora australis.');
  const third = optimizePrompt('Return `x509SubjectAltName` unchanged.');
  assert.match(first.optimizedPrompt, /basalt weathering/i);
  assert.match(second.optimizedPrompt, /aurora australis/i);
  assert.match(second.optimizedPrompt, /3 causes/i);
  assert.notEqual(first.originalPrompt, second.originalPrompt);
  assert.equal(third.optimizedPrompt, third.originalPrompt);
  assert.equal(second.impact.originalTokens, second.originalTokens.tokens);
  assert.equal(second.impact.optimizedTokens, second.optimizedTokens.tokens);
  assert.equal(optimizePrompt('Could you please explain basalt weathering?').optimizedPrompt, first.optimizedPrompt);
});

test('template suggestion is derived from and preserves the current user prompt', () => {
  const result = optimizePrompt('Compare the Galilean and Trojan moons under 3 headings.');
  assert.equal(result.templateSuggestion.filledPrompt, result.originalPrompt);
  assert.ok(result.templateSuggestion.slotsUsed);
});

test('production optimizer remains local and contains no external AI request code', async () => {
  const source = await readFile(new URL('./optimizer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/);
  assert.doesNotMatch(source, /openai|anthropic|gemini|claude|grok/i);
});
