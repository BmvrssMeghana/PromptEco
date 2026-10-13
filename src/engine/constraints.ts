/**
 * PromptEco Constraint Extractor & Preservation Guard
 * Identifies and preserves critical constraints:
 * - Negations (not, never, without, avoid)
 * - Quantities & Numbers (top 5, 2 examples, 300 words)
 * - Output formats (JSON, Markdown, table, bullets)
 * - Code syntax & programming languages
 * - Key domain terms
 */

export interface ExtractedConstraints {
  negations: string[];
  quantities: string[];
  outputFormats: string[];
  languagesAndTech: string[];
  preservedPhrases: string[];
  hasCodeBlock: boolean;
}

const PROGRAMMING_LANGUAGES = [
  'python', 'javascript', 'typescript', 'rust', 'golang', 'go', 'java', 'c\\+\\+', 'c#', 'c',
  'ruby', 'php', 'swift', 'kotlin', 'sql', 'html', 'css', 'bash', 'powershell', 'r', 'dart',
  'react', 'vue', 'angular', 'next\\.js', 'svelte', 'node\\.js', 'docker', 'kubernetes'
];

const OUTPUT_FORMATS = [
  'json', 'markdown', 'csv', 'yaml', 'xml', 'table', 'bullet points', 'numbered list',
  'step-by-step', 'plain text', 'pseudocode', 'summary table', 'latex'
];

const NEGATION_PATTERNS = [
  /\b(?:do not|don't|does not|doesn't|did not|didn't)\b/gi,
  /\b(?:never|without|exclude|excluding|avoid|no|none|neither|nor)\b/gi,
  /\b(?:should not|shouldn't|cannot|can't|must not|mustn't)\b/gi,
  /\b(?:with no|except for|except)\b/gi
];

const QUANTITY_PATTERNS = [
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+[a-z]+/gi,
  /\b\d+\s+(?:examples|paragraphs|words|sentences|items|points|bullets|reasons|steps|pages|lines)\b/gi,
  /\b(?:top|first|last|maximum|minimum|at least|at most|under|over|around|exactly)\s+\d+\b/gi,
  /\b\d+\b/g
];

/**
 * Extracts constraints that must strictly be retained during optimization
 */
export function extractConstraints(prompt: string): ExtractedConstraints {
  const result: ExtractedConstraints = {
    negations: [],
    quantities: [],
    outputFormats: [],
    languagesAndTech: [],
    preservedPhrases: [],
    hasCodeBlock: /```[\s\S]*?```|`[^`]+`/.test(prompt)
  };

  if (!prompt || !prompt.trim()) return result;

  // 1. Negations
  for (const regex of NEGATION_PATTERNS) {
    const matches = prompt.match(regex);
    if (matches) {
      result.negations.push(...matches.map(m => m.trim().toLowerCase()));
    }
  }
  result.negations = Array.from(new Set(result.negations));

  // 2. Quantities
  for (const regex of QUANTITY_PATTERNS) {
    const matches = prompt.match(regex);
    if (matches) {
      result.quantities.push(...matches.map(m => m.trim()));
    }
  }
  result.quantities = Array.from(new Set(result.quantities)).slice(0, 10);

  // 3. Output Formats
  for (const fmt of OUTPUT_FORMATS) {
    const regex = new RegExp(`\\b${fmt}\\b`, 'i');
    if (regex.test(prompt)) {
      result.outputFormats.push(fmt);
    }
  }

  // 4. Programming Languages & Tech
  for (const lang of PROGRAMMING_LANGUAGES) {
    const regex = new RegExp(`\\b${lang}\\b`, 'i');
    const match = prompt.match(regex);
    if (match) {
      result.languagesAndTech.push(match[0]);
    }
  }

  return result;
}

/**
 * Verifies that candidate rewritten prompt does not drop any critical constraints
 */
export function verifyConstraintIntegrity(
  _original: string,
  candidate: string,
  constraints: ExtractedConstraints
): { isValid: boolean; missingConstraints: string[] } {
  const missingConstraints: string[] = [];
  const candidateLower = candidate.toLowerCase();

  // Check negations
  for (const neg of constraints.negations) {
    if (!candidateLower.includes(neg)) {
      // Check if equivalent negation exists (e.g. "don't" vs "do not")
      if (neg === "don't" && candidateLower.includes("do not")) continue;
      if (neg === "do not" && candidateLower.includes("don't")) continue;
      if (neg === "can't" && candidateLower.includes("cannot")) continue;
      if (neg === "cannot" && candidateLower.includes("can't")) continue;
      missingConstraints.push(`Negation: "${neg}"`);
    }
  }

  // Check quantities that specify specific items or counts
  for (const qty of constraints.quantities) {
    // Only check word-level quantity phrases like "two examples", "5 steps"
    if (/\s+/.test(qty) && !candidateLower.includes(qty.toLowerCase())) {
      missingConstraints.push(`Quantity: "${qty}"`);
    }
  }

  // Check output formats
  for (const fmt of constraints.outputFormats) {
    if (!candidateLower.includes(fmt.toLowerCase())) {
      missingConstraints.push(`Format: "${fmt}"`);
    }
  }

  // Check languages and tech
  for (const tech of constraints.languagesAndTech) {
    if (!candidateLower.includes(tech.toLowerCase())) {
      missingConstraints.push(`Technology: "${tech}"`);
    }
  }

  return {
    isValid: missingConstraints.length === 0,
    missingConstraints
  };
}
