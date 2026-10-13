/**
 * Deterministic, local-only prompt analysis and conservative optimization.
 *
 * Design
 * ------
 * 1. PROTECT   – code, quotes, URLs, paths, placeholders, tables, data tags… are swapped
 *                for opaque placeholders so rules can never touch them (and prose *around*
 *                code can still be optimized, unlike "skip the whole prompt").
 * 2. REWRITE   – an ordered list of small, single-purpose rules. Sentence-level rules only
 *                fire at the start of a real sentence; abbreviations / list markers /
 *                headings are respected.
 * 3. VERIFY    – every result must (a) pass the project's constraint-integrity check,
 *                (b) keep every "critical" token (negations, limits, numbers, ALL-CAPS
 *                emphasis…) and (c) actually be cheaper. If the combined result fails,
 *                rules are re-applied one at a time and only the safe ones are kept.
 * 4. FALL BACK – when in doubt, the original prompt is returned untouched.
 */

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

/* ────────────────────────────────────────────────────────────────────────────
 * Shared vocabulary
 * ──────────────────────────────────────────────────────────────────────────── */

const MAX_OPTIMIZABLE_LENGTH = 500_000;

/** Verbs that make a sentence a direct instruction once polite framing is stripped. */
const IMP_WORDS = String.raw`(?:explain|describe|summari[sz]e|compare|contrast|analy[sz]e|evaluate|write|draft|create|build|implement|debug|fix|translate|list|define|outline|plan|review|calculate|convert|generate|teach|give|provide|show|suggest|recommend|rewrite|rephrase|paraphrase|improve|optimi[sz]e|refactor|find|identify|solve|simplify|proofread|edit|classify|extract|compose|brainstorm|tell|check|compute|make|add|remove|update|design|develop|prepare|produce|sort|format|critique|verify|test|document|walk|help|break down|go over|look at|come up with|assess|rank|rate|estimate|predict|diagnose|troubleshoot|elaborate|clarify|expand|shorten|draw|visuali[sz]e|code|script|answer|respond|reply|read)`;
const IMP_LA = String.raw`(?=${IMP_WORDS}\b)`;
const IMP_START = new RegExp(String.raw`^${IMP_WORDS}\b`, 'i');

const WH = String.raw`(?:what|who|whom|whose|when|where|which|why|how)`;

/** Words that are never worth a second look when they stutter. */
const STUTTER_SAFE = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'it', 'i', 'you',
  'my', 'me', 'this', 'these', 'those', 'please', 'explain', 'describe', 'write', 'give', 'tell', 'make',
  'create', 'list', 'show', 'about', 'how', 'what', 'why', 'who', 'when', 'where', 'which', 'if', 'but',
  'be', 'are', 'we', 'they', 'he', 'she', 'them', 'us', 'our', 'your', 'its', 'into', 'than', 'then',
  'there', 'their', 'also', 'just'
]);

const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'sr', 'jr', 'fig', 'inc', 'ltd', 'co', 'cf',
  'approx', 'dept', 'no', 'vol', 'pp', 'al', 'etc.', 'u.s', 'u.k', 'a.m', 'p.m'
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Protected-segment masking
 * ──────────────────────────────────────────────────────────────────────────── */

const OPEN = '\uE000';
const CLOSE = '\uE001';
const DIGIT_BASE = 0xe100;

const encodeIndex = (i: number): string =>
  String(i).split('').map(d => String.fromCharCode(DIGIT_BASE + Number(d))).join('');
const decodeIndex = (s: string): number =>
  Number([...s].map(c => c.charCodeAt(0) - DIGIT_BASE).join(''));

const DATA_TAGS =
  'examples?|inputs?|outputs?|documents?|data|context|text|code|quotes?|passages?|articles?|emails?|transcripts?|json|xml|samples?|snippets?|content|sources?|references?|queries|query|logs?|files?';

/** Order matters: bigger structures first so smaller ones are consumed inside them. */
const PROTECTED_PATTERNS: RegExp[] = [
  /(```|~~~)[\s\S]*?(?:\1|$)/g,                                   // fenced code (even unclosed)
  /`[^`\n]+`/g,                                                    // inline code
  /^[ \t]*>.*$/gm,                                                 // block quotes
  /^[ \t]*\|.*\|[ \t]*$/gm,                                        // markdown tables
  new RegExp(String.raw`<(${DATA_TAGS})(?:\s[^>]*)?>[\s\S]*?</\1\s*>`, 'gi'), // data-bearing XML blocks
  /<\/?[A-Za-z][\w:.-]*(?:\s[^<>\n]*)?\/?>/g,                      // any other tag / <placeholder>
  /\$\$[\s\S]+?\$\$/g,                                             // display math
  /\\\([\s\S]+?\\\)/g,                                             // \( inline math \)
  /\\\[[\s\S]+?\\\]/g,                                             // \[ display math \]
  /\{\{[^{}\n]+\}\}/g,                                             // {{template}}
  /\$\{[^{}\n]+\}/g,                                               // ${var}
  /\{[A-Za-z_][\w.-]*\}/g,                                         // {var}
  /\[[^\[\]\n]{1,100}\](?:\([^)\n]*\))?/g,                         // [PLACEHOLDER] and [links](url)
  /"[^"\n]+"/g,                                                    // "double quoted"
  /“[^”\n]+”/g,                                                    // “curly quoted”
  /«[^»\n]+»/g,                                                    // «guillemets»
  /(?<![\w])'[^'\n]{2,}'(?![\w])/g,                                // 'single quoted' (not apostrophes)
  /\b(?:https?|ftp):\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi,         // URLs
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,                                 // e-mail addresses
  /(?<![\w/])(?:[A-Za-z]:\\|~\/|\.{1,2}\/|\/)[\w.\-~/\\]+/g,       // file paths
  /\b[\w-]+\.(?:py|js|ts|tsx|jsx|json|md|txt|csv|ya?ml|html|css|java|cpp|go|rs|rb|php|sql|sh|xml|pdf|docx?|xlsx?|pptx?)\b/gi, // file names
  /(?<![\w])[@#][\w-]+/g                                           // @mentions / #tags
];

interface Masked { text: string; segments: string[] }

function maskProtected(text: string): Masked {
  const segments: string[] = [];
  let out = text;
  for (const pattern of PROTECTED_PATTERNS) {
    out = out.replace(pattern, match => {
      segments.push(match);
      return OPEN + encodeIndex(segments.length - 1) + CLOSE;
    });
  }
  return { text: out, segments };
}

function unmask(text: string, segments: string[]): string {
  let out = text;
  for (let depth = 0; depth < 8 && out.includes(OPEN); depth++) {
    out = out.replace(/\uE000([\uE100-\uE109]+)\uE001/g, (_m, idx: string) => segments[decodeIndex(idx)] ?? '');
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sentence / line machinery
 * ──────────────────────────────────────────────────────────────────────────── */

interface SentenceInfo { atStart: boolean; isList: boolean }
type SentenceFn = (sentence: string, info: SentenceInfo) => string;

/** Leading heading / list marker, e.g. "## ", "- ", "1. ", "a) ", "- [ ] ". */
const LINE_LEAD = /^[ \t]*(?:#{1,6}[ \t]+|(?:[-*+•]|\d{1,3}[.)]|[a-z]\))[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

function splitSentences(body: string): Array<{ text: string; gap: string }> {
  const boundary = /([.!?]+["'”’)\]]*)([ \t]+)(?=[A-Z0-9"“‘'(\[\uE000])/g;
  const parts: Array<{ text: string; gap: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(body)) !== null) {
    const punct = m[1] ?? '';
    const before = body.slice(last, m.index);
    const word = ((/(\S+)$/.exec(before)?.[1] ?? '').toLowerCase()).replace(/^[("'“‘[]+/, '');
    if (punct.startsWith('.') && punct.length === 1) {
      const isAbbrev = ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word) || /^\d+$/.test(word) || /^(?:[a-z]\.)+[a-z]$/i.test(word);
      if (isAbbrev) continue;
    }
    const end = m.index + punct.length;
    parts.push({ text: body.slice(last, end), gap: m[2] ?? ' ' });
    last = end + (m[2]?.length ?? 0);
  }
  parts.push({ text: body.slice(last), gap: '' });
  return parts;
}

/** Tidy a rewritten sentence: strip orphan punctuation, restore capitalisation and ?→. */
function finalizeSentence(original: string, next: string, atStart: boolean): string {
  let s = next.replace(/^[\s,;:]+/, '').trim();
  if (!s) return '';
  if (atStart && /^[A-Z]/.test(original) && /^[a-z]/.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  if (/\?+$/.test(s) && IMP_START.test(s)) s = s.replace(/\?+$/, '.');
  return s;
}

function mapSentences(text: string, fn: SentenceFn): string {
  const out: string[] = [];
  let prevEnded = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) { out.push(''); prevEnded = true; continue; }
    const lead = LINE_LEAD.exec(line)?.[0] ?? '';
    const body = line.slice(lead.length);
    const isList = lead.trim().length > 0;
    let rebuilt = '';
    splitSentences(body).forEach((part, j) => {
      const atStart = j > 0 || prevEnded || isList;
      const next = part.text.trim() ? fn(part.text, { atStart, isList }) : part.text;
      const cleaned = next === part.text ? next : finalizeSentence(part.text, next, atStart);
      if (cleaned) rebuilt += cleaned + part.gap;
    });
    rebuilt = rebuilt.trimEnd();
    prevEnded = /[.!?:;\uE001]$/.test(body.trimEnd()) || /^\s*#/.test(lead);
    if (rebuilt) out.push(lead + rebuilt);
  }
  return out.join('\n');
}

const matchCase = (source: string, replacement: string): string =>
  /^[A-Z]/.test(source) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;

/* ────────────────────────────────────────────────────────────────────────────
 * Rules
 * ──────────────────────────────────────────────────────────────────────────── */

interface Rule {
  id: string;
  label: string;
  /** Lexical rules use English phrasing and are skipped for non-English prompts. */
  lexical: boolean;
  run: (maskedText: string) => string;
}

const sentenceRule = (id: string, label: string, fn: SentenceFn, lexical = true): Rule =>
  ({ id, label, lexical, run: text => mapSentences(text, fn) });

/** Apply `strip` repeatedly (nested framing like "Hi, so can you please…"). */
function peel(sentence: string, strip: (s: string) => string, rounds = 4): string {
  let s = sentence;
  for (let i = 0; i < rounds; i++) {
    const next = strip(s);
    if (next === s || !next.trim()) break;
    s = next;
  }
  return s;
}

/* ---------- structural / language-agnostic ---------- */

const invisibleChars: Rule = {
  id: 'invisible', label: 'Removed invisible characters', lexical: false,
  run: t => t.replace(/[\u200B\u2060\uFEFF\u00AD]/g, '')
};

function normalizeWhitespaceText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .split('\n')
    .map(line => {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      const rest = line.slice(indent.length).replace(/[ \t]+/g, ' ').trimEnd();
      if (!rest) return '';
      // Keep indentation only for (nested) list items; elsewhere it is just token noise.
      return /^(?:[-*+•]|\d{1,3}[.)]|[a-z]\))\s/.test(rest) ? indent.replace(/\t/g, '  ') + rest : rest;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const whitespace: Rule = { id: 'whitespace', label: 'Normalized whitespace', lexical: false, run: normalizeWhitespaceText };

const decorativeRuns: Rule = {
  id: 'decorative', label: 'Collapsed decorative separators', lexical: false,
  run: t => t.replace(/([-=_*~+])\1{4,}/g, '$1$1$1')
};

const repeatedPunctuation: Rule = {
  id: 'punct', label: 'Collapsed repeated punctuation', lexical: false,
  run: t => t
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/\.{4,}/g, '...')
    .replace(/(?<![.,]),{2,}/g, ',')
    .replace(/;{2,}/g, ';')
};

/* ---------- verbal filler ---------- */

const verbalFiller: Rule = {
  id: 'verbal', label: 'Removed verbal filler', lexical: true,
  run: t => t.replace(/(?<![\w'-])(?:[Uu]m+|[Uu]h+|[Ee]rm|[Hh]mm+)(?![\w'-])[,.!?…]*[ \t]*/g, '')
};

/* ---------- greetings & social filler ---------- */

const GREETING_WORD = String.raw`(?:(?:hey|hello|hi|hiya|howdy|greetings)(?:\s+there)?|good\s+(?:morning|afternoon|evening))`;
const ADDRESSEE = String.raw`(?:claude|chatgpt|gpt|gemini|copilot|assistant|bot|ai)`;
const GREETING_SENTENCE = new RegExp(String.raw`^(?:${GREETING_WORD}(?:\s*,?\s*${ADDRESSEE})?|dear\s+${ADDRESSEE})[\s,.!:;-]*$`, 'i');
const GREETING_NAMED = new RegExp(String.raw`^(?:${GREETING_WORD}|dear)[\s,]+${ADDRESSEE}\b[\s,.!:;-]*`, 'i');
const GREETING_PUNCT = new RegExp(String.raw`^${GREETING_WORD}\s*[,!.:;-]+(?!\s*world\b)\s*`, 'i');
const GREETING_SPACE = new RegExp(
  String.raw`^${GREETING_WORD}\s+(?=(?:please|can|could|would|will|i|i'm|i've|i'd|my|so|is|are|what|how|why|when|where|who|which|do|does|${IMP_WORDS})\b)`, 'i');
const SOCIAL_SENTENCE = new RegExp(
  String.raw`^(?:how are you(?: doing)?(?: today)?|how(?:'s| is) it going|how(?:'s| is) your (?:day|week)(?: going)?|i hope (?:you(?:'re| are)|this (?:message|email) finds you) (?:doing )?(?:well|good|great|okay|ok)(?: today)?|hope you(?:'re| are) (?:doing )?(?:well|good|great)(?: today)?)[?.!\s]*$`, 'i');

const greeting = sentenceRule('greeting', 'Removed greeting', (s, info) => {
  if (!info.atStart) return s;
  const t = s.trim();
  if (GREETING_SENTENCE.test(t) || SOCIAL_SENTENCE.test(t)) return '';
  return peel(s, cur => {
    for (const re of [GREETING_NAMED, GREETING_PUNCT, GREETING_SPACE]) {
      const n = cur.replace(re, '');
      if (n !== cur && n.trim()) return n;
    }
    return cur;
  }, 2);
});

/* ---------- discourse markers ---------- */

const FOLLOW_AFTER_FILLER =
  String.raw`(?:can|could|would|will|please|i|i'm|i'd|i've|my|${WH}|do|does|is|are|${IMP_WORDS})`;
const DISCOURSE = new RegExp(
  String.raw`^(?:(?:so|well|okay|ok|alright|right|anyway|anyways|actually|basically|honestly|essentially|obviously|you know|i mean)\s*,\s*|(?:so|okay|ok|alright|anyway|anyways|well)\s+(?=${FOLLOW_AFTER_FILLER}\b))`, 'i');

const discourse = sentenceRule('discourse', 'Removed conversational filler', (s, info) =>
  info.atStart ? peel(s, cur => cur.replace(DISCOURSE, ''), 3) : s);

/* ---------- generic preamble ---------- */

const PREAMBLE_WHOLE: RegExp[] = [
  /^(?:i am|i'm) (?:currently |just )?(?:working on|doing|building|making) (?:a|an|my|this) (?:project|assignment|task|thing|something|homework)(?: right now| at the moment)?[.!:,\s]*$/i,
  /^i (?:have|got) (?:a|one) (?:quick |simple |small )?(?:question|problem|issue)(?: for you)?[.!:,\s]*$/i,
  /^i (?:need|want|require) (?:some |your )?(?:help|assistance)(?: please)?[.!:,\s]*$/i
];
const PREAMBLE_JOINED = new RegExp(
  String.raw`^(?:i am|i'm) (?:currently |just )?(?:working on|doing|building|making) (?:a|an|my|this) (?:project|assignment|task|thing|something|homework)(?: right now| at the moment)?\s*(?:,|and so|and|so)\s*(?=(?:i was wondering|could you|can you|would you|i need|i want|i'd like|please)\b)`, 'i');

const preamble = sentenceRule('preamble', 'Removed generic preamble', (s, info) => {
  if (!info.atStart) return s;
  const t = s.trim();
  if (PREAMBLE_WHOLE.some(re => re.test(t))) return '';
  return s.replace(PREAMBLE_JOINED, '');
});

/* ---------- conversational framing ("I was wondering if…") ---------- */

const CONVERSATIONAL: RegExp[] = [
  new RegExp(String.raw`^i was (?:just )?(?:wondering|hoping|thinking) (?:if|whether) (?:you|someone|anyone) (?:could|can|would|might|may)(?: possibly)?\s*,?\s+(?:please\s+)?(?:help me (?:to )?)?${IMP_LA}`, 'i'),
  /^i (?:just )?(?:have|got) (?:a|one) (?:(?:quick|simple|small|short|silly|dumb|stupid|basic|random) )*question(?: for you)?\s*[:,.\-–—]\s*/i,
  /^(?:just )?(?:a )?(?:quick|simple|small|short|silly|dumb|stupid|random) question\s*[:,.\-–—]\s*/i,
  /^this (?:may|might|could) be (?:a |an )?(?:silly|dumb|stupid|basic|simple|noob|newbie|obvious|random) question,?\s*but\s+/i,
  /^sorry (?:to bother you|for (?:bothering you|the (?:silly|dumb|stupid|basic) question)),?\s*but\s+/i,
  // Self-effacing apologies around a request add no task constraints. Keep the
  // clause after the contrast marker ("but") for the request rules to process.
  /^i(?:'m| am) sorry (?:if )?(?:this|it) (?:is|is being|was) (?:a lot|too much|so much) to ask,?\s*but\s+/i,
  /^i(?:'m| am) sorry (?:to ask|for asking),?\s*but\s+/i,
  /^(?:if you don'?t mind|if it'?s not too much trouble|when you get a (?:chance|moment)|if you have (?:the )?time|if you(?:'re| are) (?:free|available))\s*,\s*/i,
  /^i(?:'m| am) not sure (?:how to (?:ask|phrase) this|if this is the right place),?\s*but\s+/i
];

const conversationalFraming = sentenceRule('conversational', 'Removed conversational framing', (s, info) =>
  info.atStart ? peel(s, cur => { for (const re of CONVERSATIONAL) { const n = cur.replace(re, ''); if (n !== cur) return n; } return cur; }) : s);

/* ---------- polite request framing ("Can you please…", "I need you to…") ---------- */

const MODAL = String.raw`(?:(?:can|could|would|will) you(?:\s+(?:possibly|kindly|please|just|maybe))*|would you be able to|are you able to|do you think you (?:could|can)|is it possible (?:for you )?to|would it be possible (?:for you )?to|is there any way (?:that )?you (?:could|can)|could you be so kind as to)`;
const POLITE_FRAME = new RegExp(
  String.raw`^(?:${MODAL}|i(?:'d| would) (?:like|love|appreciate)(?: it)?(?: if)? you(?: to| could| can| would)?|i (?:need|want|require) you to|i(?:'m| am) (?:asking|requesting) you to|your (?:task|job|goal|objective) is to|i(?:'d| would) like (?:for )?you to|please|kindly)\s*,?\s+(?:(?:please|kindly)\s+)?(?:(?:just|simply)\s+)?(?:help me (?:to )?)?${IMP_LA}`, 'i');

const politeFraming = sentenceRule('polite', 'Removed polite request framing', (s, info) =>
  info.atStart ? peel(s, cur => cur.replace(POLITE_FRAME, '')) : s);

/* ---------- request → direct instruction ---------- */

const REQUEST_REWRITES: Array<[RegExp, string | ((m: RegExpExecArray) => string)]> = [
  [/^help me (?:to )?(?:understand|grasp)(?: more)?(?: about)? /i, 'Explain '],
  [/^(?:tell|teach) me (?:all |everything )?about /i, 'Explain '],
  [/^tell me (how|why) /i, m => `Explain ${(m[1] ?? '').toLowerCase()} `],
  [new RegExp(String.raw`^(?:i (?:want|need) to know|i(?:'d| would) like to know|i wonder|i was wondering|i(?:'m| am) curious) (how|why) `, 'i'),
    m => `Explain ${(m[1] ?? '').toLowerCase()} `]
];

const requestToInstruction = sentenceRule('request', 'Converted request to direct instruction', (s, info) => {
  if (!info.atStart) return s;
  for (const [re, rep] of REQUEST_REWRITES) {
    const m = re.exec(s);
    if (!m) continue;
    const replacement = typeof rep === 'function' ? rep(m) : rep;
    return replacement + s.slice(m[0].length);
  }
  return s;
});

const informationRequest = sentenceRule('info', 'Condensed information request', (s, info) =>
  info.atStart
    ? s.replace(/^(?:(?:give|provide|send)(?: me)?(?: with)?|i (?:need|want)) (?:some |more )?(?:information|info) (?:about|on|regarding) /i, 'Explain ')
    : s);

const SUMMARY_REQUEST = /^(?:give|provide|write|make)(?: me| us)?(?: with)? (?:a |an |the )?(quick |brief |short |concise )?summary (?:of|for|on) /i;
const summaryRequest = sentenceRule('summary', 'Condensed summary request', (s, info) => {
  if (!info.atStart) return s;
  const m = SUMMARY_REQUEST.exec(s);
  if (!m) return s;
  const adj = (m[1] ?? '').trim().toLowerCase();
  const verb = !adj ? 'Summarize ' : adj === 'concise' ? 'Concisely summarize ' : 'Briefly summarize ';
  return verb + s.slice(m[0].length);
});

const NOMINALIZATIONS: Array<[RegExp, string]> = [
  [/\b(?:give|provide|offer|write)(?: me)?(?: with)? (?:a |an )?explanation (?:of|for|about|on) /gi, 'explain '],
  [/\b(?:give|provide|offer|write)(?: me)?(?: with)? (?:a |an )?description (?:of|for|about) /gi, 'describe '],
  [/\b(?:give|provide|offer|write)(?: me)?(?: with)? (?:a |an |the )?definition (?:of|for) /gi, 'define '],
  [/\b(?:give|provide|offer|write|do|perform)(?: me)?(?: with)? (?:a |an )?analysis (?:of|for|on) /gi, 'analyze '],
  [/\b(?:give|provide|offer|write|make)(?: me)?(?: with)? (?:a |an )?outline (?:of|for) /gi, 'outline '],
  [/\b(?:give|provide|make|write)(?: me)?(?: with)? (?:a |an )?list of /gi, 'list ']
];
const BENEFICIARY = /\b(write|draft|create|make|generate|compose|design|build) me (?=(?:a|an|the|some|\d+|one|two|three|four|five)\b)/gi;

const nominalizations: Rule = {
  id: 'nominal', label: 'Converted request to direct instruction', lexical: true,
  run: t => {
    let out = t;
    for (const [re, rep] of NOMINALIZATIONS) out = out.replace(re, m => matchCase(m, rep));
    return out.replace(BENEFICIARY, '$1 ');
  }
};

const COMPARISON_NOUN = /\b(?:make|do|perform|write|give|provide|create|draw)(?: me)? (?:a |an )?comparison (?:between|of) /gi;
const GENERIC_NOUN_AFTER_DIFFERENCE = /(\bdifference between [^,.;?!\n]+? and [^,.;?!\n]+?)[ \t]+(?:stuff|things)\b/gi;

const comparison: Rule = {
  id: 'comparison', label: 'Condensed comparison request', lexical: true,
  run: t => t.replace(COMPARISON_NOUN, m => matchCase(m, 'compare ')).replace(GENERIC_NOUN_AFTER_DIFFERENCE, '$1')
};

const EX_QTY = String.raw`(?:some|a few|several|a couple of|one|two|three|four|five|six|\d+)`;
const EXAMPLES = new RegExp(
  String.raw`(?<=[\w\uE001])[ \t]*,?[ \t]*(?:and[ \t]+)?(?:then[ \t]+)?(?:(?:maybe|also|perhaps)[ \t]+)*(?:please[ \t]+)?(?:give|provide|show|include|add)[ \t]+(?:me[ \t]+)?(?:(${EX_QTY})[ \t]+)?(examples?|an example)\b`, 'gi');

const exampleRequest: Rule = {
  id: 'examples', label: 'Condensed example request', lexical: true,
  run: t => t.replace(EXAMPLES, (_m, qty: string | undefined, word: string) => {
    const q = qty?.trim().toLowerCase();
    return ` with ${q && q !== 'some' ? `${q} ` : ''}${word.toLowerCase()}`;
  })
};

/* ---------- wordy phrases ---------- */

const PER_BASIS: Record<string, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly', regular: 'regularly' };
const WORDY: Array<[RegExp, string | ((m: string, g1?: string) => string)]> = [
  [/\b(?:due|owing) to the fact that\b|\bin view of the fact that\b|\bon account of the fact that\b/gi, 'because'],
  [/\bgiven the fact that\b/gi, 'since'],
  [/\bin spite of the fact that\b|\bdespite the fact that\b/gi, 'although'],
  [/\bin order to\b|\bso as to\b/gi, 'to'],
  [/\bat this point in time\b|\bat the present time\b|\bat this moment in time\b|\bat the current time\b/gi, 'now'],
  [/\bin the event that\b/gi, 'if'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bwith regards? to\b|\bin regards? to\b|\bwith reference to\b|\bpertaining to\b/gi, 'about'],
  [/\ba (?:large|great|good) number of\b/gi, 'many'],
  [/\b(?:the vast|a large) majority of\b|\b(?:the|a) majority of\b/gi, 'most'],
  [/\b(?:is|are) able to\b|\b(?:has|have) the ability to\b/gi, 'can'],
  [/\beach and every\b/gi, 'every'],
  [/\bfirst and foremost\b/gi, 'first'],
  [/\bwhether or not\b/gi, 'whether'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bin the near future\b/gi, 'soon'],
  [/\bmake use of\b/gi, 'use'],
  [/\butili[sz]e\b/gi, 'use'],
  [/\bmake a decision\b/gi, 'decide'],
  [/\btake into (?:consideration|account)\b/gi, 'consider'],
  [/\bin a timely manner\b/gi, 'promptly'],
  [/\bthe reason why\b/gi, 'the reason'],
  [/\bhelp me out\b/gi, 'help me'],
  [/\bon a (daily|weekly|monthly|yearly|regular) basis\b/gi, (_m, g1) => PER_BASIS[(g1 ?? '').toLowerCase()] ?? _m],
  [/\b(explain|describe) to me\b/gi, (_m, g1) => (g1 ?? '').toLowerCase()],
  [/\bto be honest,?[ \t]*|\bneedless to say,?[ \t]*|\bas you (?:may )?know,?[ \t]*/gi, '']
];

const wordyPhrases: Rule = {
  id: 'wordy', label: 'Condensed wordy phrasing', lexical: true,
  run: t => {
    let out = t;
    for (const [re, rep] of WORDY) {
      out = out.replace(re, (m: string, g1?: string) => {
        const r = typeof rep === 'function' ? rep(m, g1) : rep;
        return r ? matchCase(m, r) : '';
      });
    }
    return out;
  }
};

/* ---------- filler adverbs & redundant politeness ---------- */

const FILLER_WORDS = /(?<![\w-])(?:basically|essentially|honestly|obviously|frankly)(?![\w-])[ \t]*,?[ \t]*/gi;
const fillerWords = sentenceRule('filler', 'Removed filler words', s => s.replace(FILLER_WORDS, ''));

const PLEASE_END = /,?[ \t]*(?<!\b(?:to|will|would|can|may|must|not|and|or|which|that|who)[ \t])\bplease(?=[.!?]*$)/i;
const redundantPlease = sentenceRule('please', 'Removed polite request framing', (s, info) => {
  let out = s;
  if (info.atStart) out = out.replace(/^(?:please|kindly)\s*,?\s+(?=\S)/i, '');
  out = out
    .replace(PLEASE_END, '')
    .replace(/,[ \t]*please[ \t]*,/gi, ',')
    .replace(new RegExp(String.raw`\b(?:please|kindly)[ \t]+(?=${IMP_WORDS}\b)`, 'gi'), '');
  return out;
});

/* ---------- closing courtesies ---------- */

const COURTESY_SENTENCE = new RegExp(
  String.raw`^(?:(?:thanks|thank you|thx|many thanks|cheers|much appreciated)(?:[\s,]+(?:so|very))?(?:[\s,]+(?:much|a lot|a ton|in advance|again|for (?:your|the) (?:help|time|assistance|support|response|answer|reply)))*|(?:i )?(?:really |truly |greatly )?appreciate (?:your|the) (?:help|time|assistance|support|effort|response)|(?:any|your) help (?:would be|is) (?:much |greatly |really )?appreciated|hope (?:this|that|it) makes sense|hope (?:this|that) helps|let me know if you have any (?:more |other |further )?questions|feel free to ask(?: if you have any questions)?|i look forward to (?:your|hearing)[^.!?]*|have a (?:great|nice|good) day)[\s.!]*$`, 'i');
const COURTESY_TRAILING = /(?:,|;|[ \t][-–—]|[ \t](?:and|but))[ \t]*(?:thanks|thank you|thx)(?:[ \t]+(?:so much|a lot|in advance|very much))?[.!]*$|[ \t]+thanks in advance[.!]*$/i;

const closingCourtesy = sentenceRule('courtesy', 'Removed closing courtesy', s => {
  const t = s.trim();
  if (COURTESY_SENTENCE.test(t)) return '';
  const n = s.replace(COURTESY_TRAILING, '');
  if (n === s) return s;
  return /[.!?]$/.test(n.trim()) ? n : `${n.trimEnd()}.`;
});

/* ---------- repetition ---------- */

const repeatedWords: Rule = {
  id: 'dup-words', label: 'Removed repeated word', lexical: true,
  run: t => t.replace(/(?<![\w'-])([A-Za-z']{1,})([ \t]+)\1(?![\w'-])/gi, (m, word: string) =>
    STUTTER_SAFE.has(word.toLowerCase()) ? word : m)
};

const repeatedSentences: Rule = {
  id: 'dup-sentences', label: 'Removed repeated instruction', lexical: false,
  run: text => {
    // Intentional repetition ("say it twice") or few-shot formats are left alone.
    if (/\b(?:repeat|twice|thrice|again|echo|duplicate|\d+\s+times)\b/i.test(text)) return text;
    const seen = new Set<string>();
    return mapSentences(text, (s, info) => {
      if (info.isList || s.includes(OPEN)) return s;
      if (s.trim().split(/\s+/).length < 5 || /^[\w .'-]{1,24}:\s/.test(s) || /:\s*$/.test(s)) return s;
      const key = s.trim()
        .replace(/^(?:please\s+|can you please\s+|could you please\s+)/i, '')
        .replace(/[.!?]+$/, '').replace(/\s+/g, ' ').toLocaleLowerCase();
      if (seen.has(key)) return '';
      seen.add(key);
      return s;
    });
  }
};

/* ---------- final tidy ---------- */

const finalCleanup: Rule = {
  id: 'cleanup', label: 'Normalized whitespace', lexical: true,
  run: t => normalizeWhitespaceText(
    t.replace(/[ \t]+([,;!?])/g, '$1')
      .replace(/[ \t]+\.(?=[ \t]|$|\n)/g, '.')
      .replace(/,[ \t]*([.!?])(?![.!?])/g, '$1')
      .replace(/([,;:])\1+/g, '$1')
      .replace(/^[ \t]*[,;]+[ \t]*/gm, ''))
};

const RULES: Rule[] = [
  invisibleChars, whitespace, decorativeRuns, repeatedPunctuation,
  verbalFiller, greeting, discourse, preamble, conversationalFraming, politeFraming,
  requestToInstruction, informationRequest, summaryRequest, nominalizations, comparison, exampleRequest,
  wordyPhrases, fillerWords, redundantPlease, closingCourtesy,
  repeatedWords, repeatedSentences, finalCleanup
];

/* ────────────────────────────────────────────────────────────────────────────
 * Safety gates
 * ──────────────────────────────────────────────────────────────────────────── */

const NUMBER_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|fifty|hundred|thousand|million|first|second|third|half|double|triple';
const CAPS_IGNORED = new Set(['PLEASE', 'HI', 'HELLO', 'HEY', 'THANKS', 'THANK', 'YOU', 'OK', 'OKAY', 'UM', 'UH']);

/** Tokens whose loss would change what the prompt *means* rather than how politely it asks. */
function criticalSignature(text: string): Set<string> {
  const sig = new Set<string>();
  const lower = text.toLowerCase().replace(/[’]/g, "'")
    .replace(/\b(?:don|doesn|didn|isn|aren|wasn|weren|won|wouldn|shouldn|couldn|can|hasn|haven|hadn)'t\b/g, ' not ')
    .replace(/\b(?:dont|doesnt|didnt|cant|wont|cannot)\b/g, ' not ');
  const words = lower.match(/\b(?:not|no|never|without|only|must|exactly|except|unless|avoid|nothing|none|neither|nor|always|ensure|required?|mandatory|strictly|maximum|minimum|max|min)\b/g) ?? [];
  words.forEach(w => sig.add(`w:${w}`));
  (lower.match(/\d+(?:[.,:/]\d+)*%?/g) ?? []).forEach(n => sig.add(`n:${n}`));
  (lower.match(new RegExp(`\\b(?:${NUMBER_WORDS})\\b`, 'g')) ?? []).forEach(n => sig.add(`nw:${n}`));
  (lower.match(/\b(?:at least|at most|no more than|no less than|up to|more than|less than|fewer than)\b/g) ?? []).forEach(p => sig.add(`p:${p}`));
  (text.match(/\b[A-Z]{2,}\b/g) ?? []).filter(w => !CAPS_IGNORED.has(w)).forEach(w => sig.add(`c:${w}`));
  return sig;
}

function keepsMeaning(original: string, candidate: string, constraints: ExtractedConstraints): boolean {
  if (!candidate.trim()) return false;
  const before = criticalSignature(original);
  const after = criticalSignature(candidate);
  for (const token of before) if (!after.has(token)) return false;
  return verifyConstraintIntegrity(original, candidate, constraints).isValid;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pipeline
 * ──────────────────────────────────────────────────────────────────────────── */

function unwrapPromptQuotation(text: string): string {
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»'], ['‹', '›']];
  for (const [open, close] of pairs) {
    if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, -close.length);
      // "A" and "B" is two quotations, not one wrapped prompt.
      if (inner.includes(open) || inner.includes(close)) continue;
      return inner.trim();
    }
  }
  return text;
}

function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 3) return true;
  const nonAscii = letters.filter(c => c.charCodeAt(0) > 127).length;
  return nonAscii / letters.length < 0.2;
}

function isStructuredData(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

function safely(rule: Rule, text: string): string {
  try { return rule.run(text); } catch { return text; }
}

function optimizeText(original: string, constraints: ExtractedConstraints): { text: string; changes: string[] } {
  const none = { text: original, changes: [] as string[] };
  if (original.length > MAX_OPTIMIZABLE_LENGTH || /[\uE000\uE001]/.test(original) || isStructuredData(original)) return none;
  if (original.split(/\s+/).length < 3) return none;

  let source = original;
  const changes: string[] = [];
  const unwrapped = unwrapPromptQuotation(source);
  if (unwrapped !== source && unwrapped) {
    if (keepsMeaning(original, unwrapped, constraints)) {
      source = unwrapped;
      changes.push('Removed outer quotation marks');
    }
  }

  const masked = maskProtected(source);
  const active = RULES.filter(rule => looksEnglish(original) || !rule.lexical);

  // Fast path: run everything, verify once.
  let current = masked.text;
  const fired: string[] = [];
  for (const rule of active) {
    const next = safely(rule, current);
    if (next !== current) { current = next; fired.push(rule.label); }
  }
  const combined = unmask(current, masked.segments);
  if (keepsMeaning(original, combined, constraints)) {
    return { text: combined, changes: [...new Set([...changes, ...fired])] };
  }

  // Slow path: keep only the rules that are individually safe.
  current = masked.text;
  const accepted: string[] = [];
  for (const rule of active) {
    const next = safely(rule, current);
    if (next === current) continue;
    if (keepsMeaning(original, unmask(next, masked.segments), constraints)) {
      current = next;
      accepted.push(rule.label);
    }
  }
  const text = unmask(current, masked.segments);
  return text === original ? none : { text, changes: [...new Set([...changes, ...accepted])] };
}

/** Avoid presenting a stripped greeting as a useful optimized instruction. */
function isCourtesyOnly(text: string): boolean {
  const remainder = text
    .replace(/^\s*(?:(?:hi|hello|hey)(?: there)?[!,\s]*)+/i, '')
    .replace(/\b(?:thanks|thank you|thx|many thanks|cheers)(?:\s+(?:so much|a lot|in advance|very much))?[.!\s,]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return remainder.length === 0;
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

  const proposed = optimizeText(original, constraints);
  const candidateTokens = countTokens(proposed.text);
  const baselineTokens = countTokens(original);

  // Only accept a rewrite that is verifiably cheaper; otherwise keep the source verbatim.
  const cheaper =
    candidateTokens.tokens < baselineTokens.tokens ||
    (candidateTokens.tokens === baselineTokens.tokens && proposed.text.length <= original.length * 0.95);
  const changed = proposed.text !== original && proposed.changes.length > 0 && cheaper && !isCourtesyOnly(original);

  const optimizedPrompt = changed ? proposed.text : original;
  const optimizedTokens = changed ? candidateTokens : baselineTokens;
  const impact = calculateCarbonImpact(originalTokens.tokens, optimizedTokens.tokens, emissionPresetId);

  return {
    originalPrompt: original,
    optimizedPrompt,
    status: changed ? 'optimized' : 'unchanged',
    changes: changed ? proposed.changes : [],
    originalTokens,
    optimizedTokens,
    impact,
    classification,
    templateSuggestion,
    constraintsPreserved: constraints
  };
}
