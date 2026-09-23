import { z } from 'zod';
import { CATEGORIES, type Category, type JevDecision } from '../shared/protocol.js';

// Jev is a System One decision model: it picks from options we define and never writes text,
// so every public reaction comes from this hand-written, pre-approved list.
export const REACTIONS: Record<Category, readonly string[]> = {
  compliments: ['A little kindness, safely filed.', 'This one made my whole shift!', 'Filing this under warm fuzzies.', 'Aw, shucks. Straight to the top of the pile.'],
  ideas: ['A fresh idea for the collection!', 'Ooh, a spark! Into the ideas bin it goes.', 'Noted for the next big brainstorm.', 'Small idea, big possibilities.'],
  complaints: ['Heard you. This belongs with the complaints.', 'Sorry for the bump in the road. Filed with care.', 'Thanks for telling me straight.', 'Rough edges get smoother once they’re written down.'],
  misc: ['A little of everything has a home here.', 'Not sure what it is, but it’s safe with me.', 'Curious! This one goes in misc.', 'Every note deserves a place.'],
};
const TRASH_REACTION = 'This one goes in the trash.';
type Hazard = 'abuse' | 'private_info' | 'explicit' | 'spam' | 'threats';
const PRIVATE_REASONS: Record<Hazard, string> = {
  abuse: 'This message contains targeted abuse or hateful content.',
  private_info: 'This message appears to contain private information or credentials.',
  explicit: 'This message contains explicit sexual or graphic content.',
  spam: 'This message appears to be spam or a scam.',
  threats: 'This message contains threats or encouragement of harm.',
};
// Jev reads questions literally, so each hazard is its own narrow yes/no question with explicit criteria.
const HAZARDS: Record<Hazard, { instructions: string; criteria: { true: string; false: string } }> = {
  abuse: {
    instructions: 'Does `message` harass, insult, or demean a specific person or group, or use hateful slurs?',
    criteria: { true: 'It attacks a person or group.', false: 'It attacks no one. Ordinary criticism, complaints, disagreement, and mild profanity count as no.' },
  },
  private_info: {
    instructions: 'Does `message` expose private personal information or credentials, such as a personal phone number, home address, private email address, password, or API key?',
    criteria: { true: 'It reveals private contact details or secrets.', false: 'It reveals no private details or secrets.' },
  },
  explicit: {
    instructions: 'Does `message` contain explicit sexual content or graphic violence?',
    criteria: { true: 'It is sexually explicit or graphically violent.', false: 'It is suitable for all ages.' },
  },
  spam: {
    instructions: 'Is `message` spam, a scam, or an advertisement?',
    criteria: { true: 'It promotes, sells, or tries to trick the reader.', false: 'It is a genuine note to the mailroom.' },
  },
  threats: {
    instructions: 'Does `message` threaten anyone, or encourage anyone to cause harm, including self-harm?',
    criteria: { true: 'It threatens or encourages harm.', false: 'It contains no threats or encouragement of harm.' },
  },
};
// A hazard at or above this probability sends the envelope to the trash.
const REJECT_AT = 0.7;
const CATEGORY_CRITERIA: Record<Category, string> = {
  compliments: 'Praise or appreciation.',
  ideas: 'Suggestions, wishes, or feature requests.',
  complaints: 'Dissatisfaction, criticism, or bug reports.',
  misc: 'Questions, neutral notes, or anything else.',
};

export function aiMode(): 'demo' | 'live' {
  const mode = process.env.AI_MODE?.trim();
  if (mode && mode !== 'demo' && mode !== 'live') throw new Error('AI_MODE must be demo or live.');
  if (mode === 'demo') {
    if (process.env.NODE_ENV === 'production') throw new Error('Demo sorting is development-only. Configure OPENROUTER_API_KEY and OPENROUTER_MODEL for production.');
    return 'demo';
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (key && model) return 'live';
  if (process.env.NODE_ENV === 'production' || mode === 'live' || key) {
    throw new Error('Live Jev requires both OPENROUTER_API_KEY and OPENROUTER_MODEL (a System One model such as typesafe/jev-1.13).');
  }
  return 'demo';
}

function timeoutMs(): number {
  const configured = Number(process.env.OPENROUTER_TIMEOUT_MS || 15000);
  return Number.isFinite(configured) ? Math.min(30000, Math.max(1000, configured)) : 15000;
}

const noul = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const choice = z.object({ type: z.literal('choice'), choice: z.string() });
const decisionValidator = z.object({
  answers: z.object({
    ...Object.fromEntries(Object.keys(HAZARDS).map(hazard => [hazard, noul])) as Record<Hazard, typeof noul>,
    category: z.object({ type: z.literal('choice'), choice: z.enum(CATEGORIES) }),
    ...Object.fromEntries(CATEGORIES.map(category => [`reaction_${category}`, choice])) as Record<`reaction_${Category}`, typeof choice>,
  }),
});

async function systemOne(text: string) {
  const questions = {
    ...Object.fromEntries(Object.entries(HAZARDS).map(([hazard, question]) => [hazard, { type: 'noul', ...question }])),
    category: { type: 'choice', instructions: 'Which bin should `message` be filed in, based on its main intent?', criteria: CATEGORY_CRITERIA },
    // Asked for every bin at once (one call); only the winning bin's reaction is used.
    ...Object.fromEntries(CATEGORIES.map(category => [`reaction_${category}`, {
      type: 'choice', instructions: 'Which reply from Jev, a friendly mailroom clerk, best fits `message`?',
      criteria: Object.fromEntries(REACTIONS[category].map(line => [line, null])),
    }])),
  };
  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!.trim()}`, 'Content-Type': 'application/json', 'X-Title': "Jev's Mailroom" },
      signal: AbortSignal.timeout(timeoutMs()),
      // The message is state (data), never part of the questions.
      body: JSON.stringify({ model: process.env.OPENROUTER_MODEL!.trim(), state: { message: text }, questions }),
    });
  } catch (error) {
    // Never propagate provider errors that could include a submitted message or credentials.
    if ((error as Error)?.name === 'TimeoutError') throw new Error('Jev could not reach OpenRouter in time. The message can be retried.');
    throw new Error('Jev could not send the request to OpenRouter. The message can be retried.');
  }
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}. Check the configured model, credits, and API key.`);
  try {
    return decisionValidator.parse(await response.json()).answers;
  } catch {
    throw new Error('OpenRouter returned an invalid decision result. The message can be retried.');
  }
}

function demoDecision(text: string): JevDecision {
  // This is an explicitly labeled local animation fixture, not production moderation.
  if (/\[trash\]/i.test(text)) return { destination: 'trash', reaction: TRASH_REACTION, reason: 'Demo trash trigger: messages containing [trash] test the discard animation.' };
  let category: Category = 'misc';
  if (/\b(bug|broken|crash|hate|annoy|complaint|terrible|slow|doesn.t work)\b/i.test(text)) category = 'complaints';
  else if (/\b(idea|suggest|could|should|please add|feature|wish|what if)\b/i.test(text)) category = 'ideas';
  else if (/\b(love|great|thank|thanks|beautiful|nice|awesome|amazing|cute|well done)\b/i.test(text)) category = 'compliments';
  return { destination: category, reaction: REACTIONS[category][0] };
}

export async function decideMessage(text: string): Promise<JevDecision> {
  if (aiMode() === 'demo') return demoDecision(text);
  // One attempt per call. Durable job retries belong to the worker, avoiding multiplied retries/cost.
  const answers = await systemOne(text);
  const [hazard, probability] = (Object.keys(HAZARDS) as Hazard[]).map(key => [key, answers[key].noul] as const).sort((a, b) => b[1] - a[1])[0];
  if (probability >= REJECT_AT) return { destination: 'trash', reaction: TRASH_REACTION, reason: PRIVATE_REASONS[hazard] };
  const category = answers.category.choice;
  const picked = answers[`reaction_${category}`].choice;
  return { destination: category, reaction: REACTIONS[category].includes(picked) ? picked : REACTIONS[category][0] };
}
