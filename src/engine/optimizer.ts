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

function unwrapPromptQuotation(text: string): string {
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»'], ['‹', '›']];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
      return text.slice(open.length, -close.length).trim();
    }
  }
  return text;
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
    const key = sentence.trim()
      .replace(/^(?:please\s+|can you please\s+|could you please\s+)/i, '')
      .replace(/[.!?]+$/, '').replace(/\s+/g, ' ').toLocaleLowerCase();
    if (key && seen.has(key)) {
      removed = true;
      continue;
    }
    if (key) seen.add(key);
    kept.push(sentence);
  }
  return { text: kept.join(' '), removed };
}

/** Collapse an immediately repeated word only when it is a clear typing stutter. */
function removeRepeatedWords(text: string): { text: string; removed: boolean } {
  if (/```|~~~|`[^`]+`|(^|\n)\s*>/m.test(text)) return { text, removed: false };
  const meaningfulRepeats = new Set(['had', 'that', 'very', 'so', 'no', 'not', 'never', 'more', 'less', 'too', 'can', 'will', 'should', 'must', 'is', 'was', 'do']);
  let removed = false;
  const result = text.replace(/\b([a-z]{2,})\b[\t ]+\1\b/gi, (match, word: string) => {
    if (meaningfulRepeats.has(word.toLocaleLowerCase())) return match;
    removed = true;
    return word;
  });
  return { text: result, removed };
}

const EXAMPLE_QUANTITY = '(?:some|one|two|three|four|five|\\d+)';

/** Compact common request grammar while carrying the captured subject through. */
function compactRequestLanguage(source: string): { text: string; changes: string[] } {
  let text = source;
  const changes: string[] = [];
  let explainedSubject = '';
  const apply = (next: string, label: string) => {
    if (next !== text) {
      text = next;
      changes.push(label);
    }
  };

  // Greetings, generic context-setting, and thanks do not alter the requested task.
  apply(text.replace(/^(?:hey there|hello there|hi there|hey|hello|hi)[,! .]+/i, ''), 'Removed greeting');
  apply(text.replace(/^(?:i am|i'm) working on a project\s*(?:and|,)\s*(?=(?:i was wondering if|could you|can you|would you)\b)/i, ''), 'Removed generic preamble');
  apply(text.replace(/^(?:i was wondering if you could help me out[,. ]*|i was wondering if you could\s*)/i, ''), 'Removed conversational framing');
  apply(text.replace(/\s*(?:thanks(?: so much)?|thank you(?: so much)?)[.! ]*$/i, ''), 'Removed closing courtesy');

  // “Tell me all about X and how it works” repeats the same explanatory intent.
  apply(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?tell me all about\s+(.+?)\s+and how (it|they) (works|work)\b/i,
    (_match, subject: string, pronoun: string, verb: string) => {
      explainedSubject = subject.trim();
      return `Explain how ${explainedSubject} ${pronoun.toLowerCase() === 'they' ? 'work' : verb.toLowerCase()}`;
    }),
  'Condensed repeated explanation request');
  apply(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?tell me all about\s+/i, 'Explain '), 'Converted request to direct instruction');
  apply(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?tell me about\s+/i, 'Explain '), 'Converted request to direct instruction');
  apply(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:tell me\s+)?how\s+(.+?)\s+works\b/i,
    (_match, subject: string) => `Explain how ${subject.trim()} works`), 'Converted question to direct instruction');
  apply(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:tell me\s+)?what is\s+(.+?)\s*[?.!]?$/i,
    (_match, subject: string) => `Explain ${subject.trim()}`), 'Converted question to direct instruction');
  apply(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:give|provide) me (?:some )?information about\s+/i, 'Explain '), 'Condensed information request');
  apply(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:(?:give|provide)(?: me)?(?: with)?\s+)?(?:a )?summary of\s+/i, 'Summarize '), 'Condensed summary request');
  apply(text.replace(/\bmake a comparison between\s+([^,.;?!]+?)\s+and\s+([^,.;?!]+?)(?=[,.;?!]|$)/gi,
    (_match, left: string, right: string) => `Compare ${left.trim()} and ${right.trim()}`), 'Condensed comparison request');
  apply(text.replace(/\bdue to the fact that\b/gi, 'because').replace(/\bin order to\b/gi, 'to').replace(/\bat this point in time\b/gi, 'now'),
    'Condensed wordy phrasing');

  // Convert explanatory “difference between” wording to a concise equivalent.
  apply(text.replace(/\b(?:explain|describe) the difference between\s+([^,.;?!]+?)\s+and\s+([^,.;?!]+?)(?:\s+(?:stuff|things))?(?=[,.;?!]|$)/gi,
    (match, left: string, right: string) => {
      const genericNoun = /\b(?:stuff|things)\s*$/i.test(match);
      const rightTerm = right.trim().replace(/\s+(?:stuff|things)$/i, '');
      return `compare ${left.trim()} and ${rightTerm}${genericNoun && explainedSubject ? ` ${explainedSubject}` : ''}`;
    }),
  'Condensed comparison request');
  apply(text.replace(/\bwhat(?:'s| is) the difference between\s+([^,.;?!]+?)\s+and\s+([^,.;?!]+?)(?:\s+(?:stuff|things))?(?=[,.;?!]|$)/gi,
    (_match, left: string, right: string) => `Compare ${left.trim()} and ${right.trim()}`),
  'Condensed comparison request');

  // “Maybe give me some / two examples” becomes a compact modifier; explicit counts remain.
  const examples = new RegExp(`,?\\s*(?:and\\s+)?(?:maybe\\s+)?(?:give|provide)\\s+(?:me\\s+)?(${EXAMPLE_QUANTITY}\\s+)?(examples?|an example)\\b`, 'gi');
  apply(text.replace(examples, (_match, quantity: string | undefined, exampleWord: string) => {
    const count = quantity?.trim().toLowerCase();
    const modifier = count && count !== 'some' ? `${count} ` : '';
    return ` with ${modifier}${exampleWord.toLowerCase()}`;
  }), 'Condensed example request');

  // Remove conversational “can you / could you” framing when a direct task follows.
  apply(text.replace(new RegExp(`^(?:can|could|would) you (?:please\\s+)?(?=${IMPERATIVE}\\b)`, 'i'), ''), 'Removed polite request framing');
  text = text.trim();
  if (changes.length && text.endsWith('?')) text = `${text.slice(0, -1)}.`;
  return { text, changes };
}

function optimizeText(original: string): { text: string; changes: string[] } {
  let text = original;
  const changes: string[] = [];
  const normalized = normalizeWhitespace(text);
  if (normalized !== text) {
    text = normalized;
    changes.push('Normalized whitespace');
  }
  const unwrapped = unwrapPromptQuotation(text);
  if (unwrapped !== text) {
    text = unwrapped;
    changes.push('Removed outer quotation marks');
  }

  // Never rewrite code-heavy prompts: they often contain significant syntax and comments.
  if (!/```|~~~|`[^`]+`/.test(text)) {
    const verbal = text.replace(/^(?:um+|uh+|erm?|hmm+)[,!.?]*\s+/i, '');
    if (verbal !== text && verbal) {
      text = verbal;
      changes.push('Removed verbal filler');
    }
    // Conversational greeting + transition is removable as framing, while a standalone
    // greeting or greeting used as a subject remains untouched.
    const conversationalStart = text.replace(/^(?:hello|hi|hey)[,!]?\s+so\s+/i, '');
    if (conversationalStart !== text && conversationalStart.trim()) {
      text = conversationalStart;
      changes.push('Removed conversational filler');
    }
    for (const opener of SAFE_OPENERS) {
      const withoutOpener = text.replace(opener.pattern, '');
      if (withoutOpener !== text && withoutOpener.trim()) {
        text = withoutOpener.trim().replace(/^([a-z])/, (_match, letter: string) => letter.toUpperCase());
        changes.push(opener.label);
        break;
      }
    }
    const compacted = compactRequestLanguage(text);
    if (compacted.text !== text) {
      text = compacted.text;
      changes.push(...compacted.changes);
    }
    const duplicate = removeRepeatedSentences(text);
    if (duplicate.removed) {
      text = duplicate.text;
      changes.push('Removed repeated instruction');
    }
    const repeatedWord = removeRepeatedWords(text);
    if (repeatedWord.removed) {
      text = repeatedWord.text;
      changes.push('Removed repeated word');
    }
    if (changes.length && text.endsWith('?')) text = `${text.slice(0, -1)}.`;
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
