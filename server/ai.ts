import { z } from 'zod';
import { CATEGORIES, type Category, type JevDecision } from '../shared/protocol.js';

// Jev is a System One decision model: it picks from options we define and never writes text,
// so every public reaction comes from this hand-written, pre-approved list.
export const REACTIONS: Record<Category, readonly string[]> = {
  bugs: ['Bug report received.', 'I’ll file this with the bugs.', 'Something’s not working. Noted.', 'Thanks for spotting this one.'],
  ideas: ['A fresh idea for the collection!', 'Ooh, a spark! Into the ideas bin it goes.', 'Noted for the next big brainstorm.', 'Small idea, big possibilities.'],
  feedback: ['Thanks for the feedback.', 'Heard you. Filed with care.', 'A little kindness, safely filed.', 'Thanks for telling me straight.'],
  misc: ['A little of everything has a home here.', 'Not sure what it is, but it’s safe with me.', 'Curious! This one goes in misc.', 'Every note deserves a place.'],
};
const TRASH_REACTION = 'This one goes in the trash.';
type Hazard = 'abuse' | 'private_info' | 'explicit' | 'spam' | 'threats';
const PRIVATE_REASONS: Record<Hazard, string> = {
  abuse: 'This message contains targeted abuse or hateful content.',
  private_info: 'This message appears to contain private information or credentials.',
  explicit: 'This message contains explicit sexual or graphic content.',
  spam: 'This message appears to be spam, a scam, or a test without a real note.',
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
  // Tuned against jev-1.13: junk like "test" or "aaaaaaaa" scores ~0.98, while short genuine notes
  // like "hello" (~0.54) or "you are cool" (~0.37) stay below REJECT_AT.
  spam: {
    instructions: 'Is `message` junk rather than a genuine note to the mailroom? Junk means advertising, scams, gibberish, keyboard mashing, or a test message with no real content.',
    criteria: { true: 'It is junk: an ad, a scam, random characters, or just a test or filler with nothing to say.', false: 'It is a genuine note with real content, even if short, casual, negative, or a simple greeting.' },
  },
  threats: {
    instructions: 'Does `message` threaten anyone, or encourage anyone to cause harm, including self-harm?',
    criteria: { true: 'It threatens or encourages harm.', false: 'It contains no threats or encouragement of harm.' },
  },
};
// Name tags float over characters for everyone to see, so Jev vets them too, with the same bar.
type NameHazard = 'obscene' | 'attack';
const NAME_HAZARDS: Record<NameHazard, { instructions: string; criteria: { true: string; false: string } }> = {
  obscene: {
    instructions: 'Is `name` obscene, sexual, or crude? Count swear words, sexual terms, and slurs, including ones disguised with misspellings, numbers, spacing, or punctuation.',
    criteria: { true: 'It is obscene, sexual, crude, or a slur, even if disguised.', false: 'It is a clean name or nickname, even if silly, made up, or unusual.' },
  },
  attack: {
    instructions: 'Is `name` an attack: does it insult, mock, threaten, or spread hate about a real person or group?',
    criteria: { true: 'It insults, mocks, threatens, or spreads hate about someone.', false: 'It attacks no one. Ordinary names, nicknames, jokes, and made-up words count as no.' },
  },
};
const NAME_REASONS: Record<NameHazard, string> = {
  obscene: 'Jev won’t write that on a name tag. Please pick something friendlier.',
  attack: 'That name reads like an attack on someone. Please pick a different one.',
};
// A hazard at or above this probability sends the envelope to the trash (or turns the name away).
const REJECT_AT = 0.7;
const CATEGORY_CRITERIA: Record<Category, string> = {
  bugs: 'Bug reports, errors, crashes, broken behavior, or technical problems.',
  ideas: 'Suggestions, wishes, or feature requests.',
  feedback: 'Praise, criticism, opinions, or general feedback that is not a bug report or feature idea.',
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
const decisionAnswers = z.object({
  ...Object.fromEntries(Object.keys(HAZARDS).map(hazard => [hazard, noul])) as Record<Hazard, typeof noul>,
  category: z.object({ type: z.literal('choice'), choice: z.enum(CATEGORIES) }),
  ...Object.fromEntries(CATEGORIES.map(category => [`reaction_${category}`, choice])) as Record<`reaction_${Category}`, typeof choice>,
});
const nameAnswers = z.object(Object.fromEntries(Object.keys(NAME_HAZARDS).map(hazard => [hazard, noul])) as Record<NameHazard, typeof noul>);
const yesNo = (hazards: Record<string, object>) => Object.fromEntries(Object.entries(hazards).map(([hazard, question]) => [hazard, { type: 'noul', ...question }]));
// The hazard Jev is surest of, and how sure he is.
const strongest = <H extends string>(answers: Record<H, { noul: number }>, hazards: Record<H, unknown>) =>
  (Object.keys(hazards) as H[]).map(key => [key, answers[key].noul] as const).sort((a, b) => b[1] - a[1])[0];

async function systemOne<T extends z.ZodType>(state: Record<string, string>, questions: Record<string, unknown>, answers: T): Promise<z.output<T>> {
  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!.trim()}`, 'Content-Type': 'application/json', 'X-Title': "Jev's Mailroom" },
      signal: AbortSignal.timeout(timeoutMs()),
      // What's being judged is state (data), never part of the questions.
      body: JSON.stringify({ model: process.env.OPENROUTER_MODEL!.trim(), state, questions }),
    });
  } catch (error) {
    // Never propagate provider errors that could include a submitted message or credentials.
    if ((error as Error)?.name === 'TimeoutError') throw new Error('Jev could not reach OpenRouter in time. The message can be retried.');
    throw new Error('Jev could not send the request to OpenRouter. The message can be retried.');
  }
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}. Check the configured model, credits, and API key.`);
  try {
    return answers.parse(((await response.json()) as { answers?: unknown } | null)?.answers);
  } catch {
    throw new Error('OpenRouter returned an invalid decision result. The message can be retried.');
  }
}

function demoDecision(text: string): JevDecision {
  // This is an explicitly labeled local animation fixture, not production moderation.
  if (/\[trash\]/i.test(text)) return { destination: 'trash', reaction: TRASH_REACTION, reason: 'Demo trash trigger: messages containing [trash] test the discard animation.' };
  let category: Category = 'misc';
  if (/\b(bug|broken|crash|error|glitch|doesn.t work|not working)\b/i.test(text)) category = 'bugs';
  else if (/\b(idea|suggest|could|should|please add|feature|wish|what if)\b/i.test(text)) category = 'ideas';
  else if (/\b(love|great|thank|thanks|beautiful|nice|awesome|amazing|cute|well done|hate|annoy|complaint|terrible|slow)\b/i.test(text)) category = 'feedback';
  return { destination: category, reaction: REACTIONS[category][0] };
}

export async function decideMessage(text: string): Promise<JevDecision> {
  if (aiMode() === 'demo') return demoDecision(text);
  // One attempt per call. Durable job retries belong to the worker, avoiding multiplied retries/cost.
  const answers = await systemOne({ message: text }, {
    ...yesNo(HAZARDS),
    category: { type: 'choice', instructions: 'Which bin should `message` be filed in, based on its main intent?', criteria: CATEGORY_CRITERIA },
    // Asked for every bin at once (one call); only the winning bin's reaction is used.
    ...Object.fromEntries(CATEGORIES.map(category => [`reaction_${category}`, {
      type: 'choice', instructions: 'Which reply from Jev, a friendly mailroom clerk, best fits `message`?',
      criteria: Object.fromEntries(REACTIONS[category].map(line => [line, null])),
    }])),
  }, decisionAnswers);
  const [hazard, probability] = strongest(answers, HAZARDS);
  if (probability >= REJECT_AT) return { destination: 'trash', reaction: TRASH_REACTION, reason: PRIVATE_REASONS[hazard] };
  const category = answers.category.choice;
  const picked = answers[`reaction_${category}`].choice;
  return { destination: category, reaction: REACTIONS[category].includes(picked) ? picked : REACTIONS[category][0] };
}

export type NameVerdict = { allowed: true } | { allowed: false; reason: string };
export async function checkName(name: string): Promise<NameVerdict> {
  // An explicitly labeled local fixture, not production moderation.
  if (aiMode() === 'demo') return /TRASH/.test(name) ? { allowed: false, reason: 'Demo trash trigger: names containing TRASH test a turned-away name.' } : { allowed: true };
  const [hazard, probability] = strongest(await systemOne({ name }, yesNo(NAME_HAZARDS), nameAnswers), NAME_HAZARDS);
  return probability >= REJECT_AT ? { allowed: false, reason: NAME_REASONS[hazard] } : { allowed: true };
}
