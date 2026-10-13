/**
 * PromptEco Local Tokenizer
 * 100% offline, local-first token counting compatible with ChatGPT models (cl100k_base / o200k_base).
 * Zero external API calls, zero server latency.
 */

import { encode } from 'gpt-tokenizer';

export interface TokenCountResult {
  tokens: number;
  wordCount: number;
  charCount: number;
  isEstimate: boolean;
  method: 'bpe-cl100k' | 'regex-heuristic';
}

/**
 * Fast regex fallback approximation if BPE ever encounters unsupported edge characters
 */
function approximateTokenCount(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  // Rule of thumb for English & code: ~4 chars per token or 0.75 words per token
  const words = text.trim().split(/\s+/).length;
  const chars = text.length;
  // Factor in punctuation, symbols, and formatting
  const punctuationCount = (text.match(/[{}\[\]()<>,.:;!?_+\-=/*&^%$#@~`|\\]/g) || []).length;
  const estimated = Math.ceil((words * 1.3) + (punctuationCount * 0.4));
  return Math.max(1, Math.min(estimated, Math.ceil(chars / 3.2)));
}

/**
 * Counts tokens for any prompt string synchronously and completely offline.
 */
export function countTokens(text: string): TokenCountResult {
  if (!text || text.trim().length === 0) {
    return {
      tokens: 0,
      wordCount: 0,
      charCount: 0,
      isEstimate: false,
      method: 'bpe-cl100k'
    };
  }

  const trimmed = text.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const charCount = text.length;

  try {
    const encoded = encode(text);
    return {
      tokens: encoded.length,
      wordCount,
      charCount,
      isEstimate: false, // Exact BPE count for ChatGPT cl100k_base
      method: 'bpe-cl100k'
    };
  } catch (err) {
    console.warn('[PromptEco] Tokenizer fallback triggered:', err);
    return {
      tokens: approximateTokenCount(text),
      wordCount,
      charCount,
      isEstimate: true,
      method: 'regex-heuristic'
    };
  }
}
