/**
 * PromptEco Task Classifier & Semantic Slot Extractor
 * Uses fast local rule-based heuristics to classify prompt intent and extract key parameters.
 * Zero external LLM or API calls.
 */

export type TaskCategory =
  | 'education'
  | 'coding'
  | 'writing'
  | 'summarization'
  | 'research'
  | 'communication'
  | 'general';

export interface TaskClassification {
  category: TaskCategory;
  confidence: 'high' | 'medium' | 'low';
  label: string;
  extractedSlots: Record<string, string>;
}

// Regex patterns for task classification
const PATTERNS: Record<TaskCategory, RegExp[]> = {
  coding: [
    /\b(?:code|function|debug|algorithm|script|api|component|refactor|sql|query|class|method|regex|database|backend|frontend)\b/i,
    /\b(?:write|create|implement|build)\s+(?:a|an)?\s*(?:python|javascript|typescript|react|java|c\+\+|rust|html|css|sql|bash)\b/i,
    /```[\s\S]*?```/,
    /\b(?:fix this error|syntax error|stack trace|npm|git)\b/i
  ],
  summarization: [
    /\b(?:summarize|summary|tldr|tl;dr|condense|shorten|brief|bullet points of|recap|abstract)\b/i,
    /\b(?:give me the main points|key takeaways)\b/i
  ],
  education: [
    /\b(?:explain|what is|how does|why is|teach me|eli5|simple words|beginner|difference between|overview of|tutorial)\b/i,
    /\b(?:give examples|how to understand)\b/i
  ],
  writing: [
    /\b(?:write a|draft a|compose|rewrite|proofread|essay|article|blog post|story|dialogue|script|poem|copywriting)\b/i,
    /\b(?:in a \w+ tone|make it sound)\b/i
  ],
  communication: [
    /\b(?:email|letter|reply to|slack message|announcement|memo|invitation|follow-up|outreach|proposal|message to my)\b/i,
    /\b(?:professional email|formal reply|polite response)\b/i
  ],
  research: [
    /\b(?:compare and contrast|deep dive|analyze|evaluate|literature review|pros and cons|historical context|methodology|breakdown)\b/i,
    /\b(?:in-depth analysis|comprehensive report)\b/i
  ],
  general: []
};

/**
 * Classifies a prompt into one of the canonical categories and extracts variables
 */
export function classifyPrompt(prompt: string): TaskClassification {
  const text = prompt.trim();
  if (!text) {
    return {
      category: 'general',
      confidence: 'low',
      label: 'General Query',
      extractedSlots: {}
    };
  }

  const scores: Record<TaskCategory, number> = {
    coding: 0,
    summarization: 0,
    education: 0,
    writing: 0,
    communication: 0,
    research: 0,
    general: 0
  };

  for (const [category, regexList] of Object.entries(PATTERNS) as [TaskCategory, RegExp[]][]) {
    for (const regex of regexList) {
      if (regex.test(text)) {
        scores[category] += 2;
      }
    }
  }

  // Find category with highest score
  let bestCategory: TaskCategory = 'general';
  let maxScore = 0;

  for (const [cat, score] of Object.entries(scores) as [TaskCategory, number][]) {
    if (score > maxScore) {
      maxScore = score;
      bestCategory = cat;
    }
  }

  const confidence: 'high' | 'medium' | 'low' =
    maxScore >= 4 ? 'high' : maxScore >= 2 ? 'medium' : 'low';

  const categoryLabels: Record<TaskCategory, string> = {
    education: 'Education & Learning',
    coding: 'Software & Code',
    writing: 'Content & Writing',
    summarization: 'Summarization',
    research: 'Research & Analysis',
    communication: 'Professional Communication',
    general: 'General Query'
  };

  const slots = extractSlotsForCategory(bestCategory, text);

  return {
    category: bestCategory,
    confidence,
    label: categoryLabels[bestCategory],
    extractedSlots: slots
  };
}

/**
 * Extracts slot parameters from prompt according to task type
 */
function extractSlotsForCategory(category: TaskCategory, text: string): Record<string, string> {
  const slots: Record<string, string> = {};

  // Generic extraction helpers
  const clean = (s?: string) => s ? s.trim().replace(/^["']|["']$/g, '').replace(/[.?!,;]$/, '') : '';

  switch (category) {
    case 'education': {
      // Explain {topic} for {audience} with {examples}
      const explainMatch = text.match(/(?:explain|what is|how does|teach me about)\s+([^.?!,]+?)(?:\s+(?:in simple words|to a beginner|to a child|for a beginner|simply|with examples|and give|in detail|using)|$)/i);
      if (explainMatch && explainMatch[1]) {
        slots.topic = clean(explainMatch[1]);
      } else {
        slots.topic = 'the topic';
      }

      if (/\b(?:simple words|eli5|like i'm 5|five year old|child|beginner)\b/i.test(text)) {
        slots.audience = 'beginners';
      }

      const exMatch = text.match(/\b(\d+|two|three|four|five|practical|real-world)\s+examples\b/i);
      if (exMatch) {
        slots.examples = `${exMatch[1]} practical examples`;
      } else if (/\bexamples?\b/i.test(text)) {
        slots.examples = 'examples';
      }
      break;
    }

    case 'coding': {
      // Write {language} code for {task} and preserve {constraints}
      const langMatch = text.match(/\b(python|javascript|typescript|react|rust|golang|go|java|c\+\+|sql|bash|html|css)\b/i);
      if (langMatch) {
        slots.language = langMatch[1];
      }

      const taskMatch = text.match(/(?:write|create|implement|code|build|debug|fix)\s+(?:a|an)?\s*([^.?!,]+)/i);
      if (taskMatch && taskMatch[1]) {
        slots.task = clean(taskMatch[1]);
      }

      // Check for constraints
      const constraintMatch = text.match(/(?:without|must not|make sure to|using|under|only)\s+([^.?!]+)/i);
      if (constraintMatch && constraintMatch[1]) {
        slots.constraints = clean(constraintMatch[1]);
      }
      break;
    }

    case 'writing': {
      // Draft {document_type} in a {tone} tone for {purpose}
      const docMatch = text.match(/\b(essay|article|blog post|story|email|cover letter|report|speech)\b/i);
      if (docMatch) {
        slots.document_type = docMatch[1];
      }

      const toneMatch = text.match(/\b(formal|casual|persuasive|friendly|professional|humorous|academic)\s+tone\b/i);
      if (toneMatch) {
        slots.tone = toneMatch[1];
      }

      const topicMatch = text.match(/(?:about|on|regarding)\s+([^.?!,]+)/i);
      if (topicMatch && topicMatch[1]) {
        slots.purpose = clean(topicMatch[1]);
      }
      break;
    }

    case 'summarization': {
      // Summarize {content} in {length} while retaining {key_points}
      const lenMatch = text.match(/\b(\d+\s+(?:sentences|bullet points|paragraphs|words)|briefly|one paragraph|short)\b/i);
      if (lenMatch) {
        slots.length = lenMatch[1];
      } else {
        slots.length = 'concise bullet points';
      }
      slots.content = 'the provided text';
      slots.key_points = 'core takeaways';
      break;
    }

    case 'communication': {
      const commDoc = text.match(/\b(email|follow-up|reply|message|announcement)\b/i);
      slots.document_type = commDoc ? commDoc[1] : 'message';
      const toMatch = text.match(/(?:to|for)\s+(?:my\s+)?(boss|team|manager|client|colleague|customer|professor)/i);
      if (toMatch) {
        slots.audience = toMatch[1];
      }
      slots.tone = 'concise and professional';
      break;
    }

    case 'research': {
      const resMatch = text.match(/(?:compare|analyze|evaluate|research)\s+([^.?!,]+)/i);
      if (resMatch && resMatch[1]) {
        slots.topic = clean(resMatch[1]);
      }
      slots.scope = 'key trade-offs, evidence, and implications';
      break;
    }

    default:
      break;
  }

  return slots;
}
