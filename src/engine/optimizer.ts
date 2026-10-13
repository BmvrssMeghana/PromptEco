/** Deterministic, local-only prompt analysis and conservative optimization. */

import { countTokens, type TokenCountResult } from './tokenizer.ts';
import { extractConstraints, verifyConstraintIntegrity, type ExtractedConstraints } from './constraints.ts';
import { calculateCarbonImpact, type CarbonAnalysis } from './carbon.ts';
import { classifyPrompt, type TaskClassification } from './classifier.ts';
import { getTemplateSuggestion, type SuggestedTemplateResult } from './templates.ts';

export interface OptimizationResult {
  originalPrompt: string;
  optimizedPrompt: string;
  status: 'optimized' | 'unchanged' | 'empty';
  changes: string[];
  originalTokens: TokenCountResult;
  optimizedTokens: TokenCountResult;
  impact: CarbonAnalysis;
  classification: TaskClassification;
  templateSuggestion: SuggestedTemplateResult;
  constraintsPreserved: ExtractedConstraints;
}

// Only remove introductory forms that leave a recognizable imperative intact.
const IMPERATIVE = '(?:explain|describe|summarize|compare|analyze|evaluate|write|draft|create|build|implement|debug|fix|translate|list|define|outline|plan|review|calculate|convert|generate|teach)';
const SAFE_OPENERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: new RegExp(`^(?:can|could|would|will) you please (?:help me to |help me )?(?=${IMPERATIVE}\\b)`, 'i'), label: 'Removed polite request framing' },
  { pattern: new RegExp(`^please (?:help me to |help me )?(?=${IMPERATIVE}\\b)`, 'i'), label: 'Removed polite request framing' },
  { pattern: new RegExp(`^i would like you to (?=${IMPERATIVE}\\b)`, 'i'), label: 'Removed polite request framing' },
  { pattern: new RegExp(`^i want you to (?=${IMPERATIVE}\\b)`, 'i'), label: 'Removed polite request framing' },
  { pattern: new RegExp(`^can you (?=${IMPERATIVE}\\b)`, 'i'), label: 'Removed polite request framing' }
];

function normalizeWhitespace(text: string): string {
  return text.replace(/[\t ]+/g, ' ').replace(/\n[\t ]+/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Repeats are removed only when the complete sentence is an exact duplicate. */
function removeRepeatedSentences(text: string): { text: string; removed: boolean } {
  // Code and quoted material may intentionally repeat; leave the whole prompt alone.
  if (/```|~~~|`[^`]+`|(^|\n)\s*>/m.test(text)) return { text, removed: false };
  const sentences = text.split(/(?<=[.!?])\s+/);
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = false;
  for (const sentence of sentences) {
    const key = sentence.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').toLocaleLowerCase();
    if (key && seen.has(key)) {
      removed = true;
      continue;
    }
    if (key) seen.add(key);
    kept.push(sentence);
  }
  return { text: kept.join(' '), removed };
}

function optimizeText(original: string): { text: string; changes: string[] } {
  let text = original;
  const changes: string[] = [];
  const normalized = normalizeWhitespace(text);
  if (normalized !== text) {
    text = normalized;
    changes.push('Normalized whitespace');
  }

  // Never rewrite code-heavy prompts: they often contain significant syntax and comments.
  if (!/```|~~~|`[^`]+`/.test(text)) {
    const verbal = text.replace(/^(?:um+|uh+|erm?|hmm+)[,!.?]*\s+/i, '');
    if (verbal !== text && verbal) {
      text = verbal;
      changes.push('Removed verbal filler');
    }
    for (const opener of SAFE_OPENERS) {
      const withoutOpener = text.replace(opener.pattern, '');
      if (withoutOpener !== text && withoutOpener.trim()) {
        text = withoutOpener.trim().replace(/^([a-z])/, (_match, letter: string) => letter.toUpperCase());
        changes.push(opener.label);
        break;
      }
    }
    const duplicate = removeRepeatedSentences(text);
    if (duplicate.removed) {
      text = duplicate.text;
      changes.push('Removed repeated instruction');
    }
  }
  return { text, changes: [...new Set(changes)] };
}

export function optimizePrompt(rawPrompt: string, emissionPresetId = 'global_average'): OptimizationResult {
  const original = rawPrompt.trim();
  const originalTokens = countTokens(rawPrompt);
  const constraints = extractConstraints(original);
  const classification = classifyPrompt(original);
  const templateSuggestion = getTemplateSuggestion(classification, original);

  if (!original) {
    return {
      originalPrompt: rawPrompt,
      optimizedPrompt: '',
      status: 'empty',
      changes: [],
      originalTokens,
      optimizedTokens: countTokens(''),
      impact: calculateCarbonImpact(0, 0, emissionPresetId),
      classification,
      templateSuggestion,
      constraintsPreserved: constraints
    };
  }

  const proposed = optimizeText(original);
  const integrity = verifyConstraintIntegrity(original, proposed.text, constraints);
  // The output is conservative: if any tracked requirement is lost, keep the source.
  const accepted = integrity.isValid ? proposed : { text: original, changes: [] as string[] };
  const changed = accepted.text !== original && accepted.changes.length > 0;
  const optimizedPrompt = changed ? accepted.text : original;
  const optimizedTokens = countTokens(optimizedPrompt);
  const impact = calculateCarbonImpact(originalTokens.tokens, optimizedTokens.tokens, emissionPresetId);

  return {
    originalPrompt: original,
    optimizedPrompt,
    status: changed ? 'optimized' : 'unchanged',
    changes: changed ? accepted.changes : [],
    originalTokens,
    optimizedTokens,
    impact,
    classification,
    templateSuggestion,
    constraintsPreserved: constraints
  };
}
