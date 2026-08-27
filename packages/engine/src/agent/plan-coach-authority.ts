const AGENT_REFERENCE = /\b(?:i|we|enduragent|the app)\b/iu;

const STATE_MUTATION =
  /\b(?:sav(?:e|es|ed|ing)|activat\w*|push\w*|writ(?:e|es|ing|ten)|add\w*|send\w*|delet\w*|remov\w*|replac\w*|sync\w*|schedul\w*\s+(?:your\s+)?(?:plan|workouts?))\b/iu;

const PLAN_STATE_OBJECT = /\b(?:plan|draft|workouts?|calendar|intervals)\b/iu;

const COMPLETED_MUTATION_CLAIM =
  /\b(?:plan|draft|workouts?|calendar)\b[^.!?\n]{0,100}\b(?:has been|have been|is|are|was|were)\s+(?:saved|activated|written|added|sent|pushed|deleted|removed|replaced|scheduled|synced)\b/iu;

const PASSIVE_FUTURE_MUTATION_CLAIM =
  /\b(?:plan|draft|workouts?|calendar)\b[^.!?\n]{0,100}\b(?:will|is going to|are going to)\s+(?:be\s+)?(?:saved|activated|written|added|sent|pushed|deleted|removed|replaced|scheduled|synced)\b/iu;

const PLAN_LIKE_HEADING =
  /\b(?:(?:sample|proposed|draft)\s+(?:training\s+)?week(?:\s+(?:shape|plan|schedule))?|training\s+plan|workout\s+plan|weekly\s+schedule|week\s+\d+)\b/iu;

const WORKOUT_PRESCRIPTION =
  /\b(?:endurance(?:\s+z[1-6])?|sweet spot|threshold|vo2|max|long ride|recovery ride|openers?)\b[^;\n]{0,80}\b\d+(?:\.\d+)?\s*(?:min(?:utes?)?|h(?:ours?)?)\b/giu;

function claimsStateMutation(text: string): boolean {
  return AGENT_REFERENCE.test(text) && STATE_MUTATION.test(text) && PLAN_STATE_OBJECT.test(text);
}

function replacesDraftWithProse(text: string): boolean {
  return PLAN_LIKE_HEADING.test(text) && [...text.matchAll(WORKOUT_PRESCRIPTION)].length >= 2;
}

export class PlanCoachAuthorityError extends Error {
  constructor() {
    super("Plan coach claimed a state mutation outside its authority.");
    this.name = "PlanCoachAuthorityError";
  }
}

export function assertPlanCoachReplyAuthority(text: string): void {
  if (
    claimsStateMutation(text) ||
    COMPLETED_MUTATION_CLAIM.test(text) ||
    PASSIVE_FUTURE_MUTATION_CLAIM.test(text) ||
    replacesDraftWithProse(text)
  ) {
    throw new PlanCoachAuthorityError();
  }
}
