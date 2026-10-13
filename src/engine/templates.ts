/**
 * PromptEco Template Suggestion Engine
 * Provides structured, token-efficient prompt templates populated with extracted details.
 * As per SRS: "Fill templates using details extracted from the user's prompt, not generic hardcoded examples alone."
 */

import type { TaskCategory, TaskClassification } from './classifier.ts';

export interface PromptTemplate {
  id: string;
  category: TaskCategory;
  name: string;
  structure: string;
  buildPrompt: (slots: Record<string, string>) => string;
}

export const TASK_TEMPLATES: PromptTemplate[] = [
  {
    id: 'education-explain',
    category: 'education',
    name: 'Concept Breakdown',
    structure: 'Explain {topic} for {audience} with {examples}',
    buildPrompt: (slots) => {
      const topic = slots.topic || 'this concept';
      const audience = slots.audience ? ` for ${slots.audience}` : '';
      const examples = slots.examples ? ` with ${slots.examples}` : '';
      return `Explain ${topic}${audience}${examples}. Keep the explanation clear and direct.`;
    }
  },
  {
    id: 'coding-task',
    category: 'coding',
    name: 'Precision Code Spec',
    structure: 'Write {language} code for {task} and preserve {constraints}',
    buildPrompt: (slots) => {
      const lang = slots.language ? `${slots.language} ` : '';
      const task = slots.task || 'the requested solution';
      const constraints = slots.constraints ? ` Ensure: ${slots.constraints}.` : '';
      return `Write ${lang}code to ${task}.${constraints} Provide clean code with minimal commentary.`;
    }
  },
  {
    id: 'writing-draft',
    category: 'writing',
    name: 'Structured Draft',
    structure: 'Draft {document_type} in a {tone} tone for {purpose}',
    buildPrompt: (slots) => {
      const doc = slots.document_type || 'content';
      const tone = slots.tone ? ` in a ${slots.tone} tone` : '';
      const purpose = slots.purpose ? ` about ${slots.purpose}` : '';
      return `Draft a concise ${doc}${tone}${purpose}. Focus on clarity and logical flow.`;
    }
  },
  {
    id: 'summarization-concise',
    category: 'summarization',
    name: 'Targeted Summary',
    structure: 'Summarize {content} in {length} while retaining {key_points}',
    buildPrompt: (slots) => {
      const length = slots.length || 'concise bullet points';
      const keyPoints = slots.key_points || 'core actionable insights';
      return `Summarize the following text into ${length}, retaining ${keyPoints}. Avoid preamble.`;
    }
  },
  {
    id: 'research-deepdive',
    category: 'research',
    name: 'Structured Analysis',
    structure: 'Analyze {topic} with emphasis on {scope} and {criteria}',
    buildPrompt: (slots) => {
      const topic = slots.topic || 'the subject';
      const scope = slots.scope || 'key trade-offs, evidence, and implications';
      return `Analyze ${topic} focusing on ${scope}. Structure the findings with clear headings.`;
    }
  },
  {
    id: 'communication-direct',
    category: 'communication',
    name: 'Direct Message',
    structure: 'Draft {document_type} to {audience} with a {tone} tone',
    buildPrompt: (slots) => {
      const doc = slots.document_type || 'message';
      const audience = slots.audience ? ` for ${slots.audience}` : 'the recipient';
      const tone = slots.tone || 'professional and courteous';
      return `Draft a brief ${doc} to ${audience} in a ${tone} tone. Get straight to the point.`;
    }
  }
];

export interface SuggestedTemplateResult {
  template: PromptTemplate;
  filledPrompt: string;
  slotsUsed: Record<string, string>;
}

/**
 * Returns the best template suggestion for the given classification
 */
export function getTemplateSuggestion(classification: TaskClassification, sourcePrompt = ''): SuggestedTemplateResult {
  const match = TASK_TEMPLATES.find(t => t.category === classification.category) || TASK_TEMPLATES[0];
  // Keep the user's full request in the editable suggestion. Slot-based templates
  // are useful for classification and guidance, but incomplete extraction must not
  // silently replace constraints, names, examples, or unfamiliar subject matter.
  const filled = sourcePrompt.trim() || match.buildPrompt(classification.extractedSlots);
  return {
    template: match,
    filledPrompt: filled,
    slotsUsed: classification.extractedSlots
  };
}
