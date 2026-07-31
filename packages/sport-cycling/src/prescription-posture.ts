export type PrescriptionCapability<EnvelopeValues> =
  | Readonly<{
      envelopeAuthorship: "unauthored";
      autonomousWorkoutProposals: "unavailable";
      envelopeValues: null;
      promptSkillKey: string;
      toolSelectionRule: string;
    }>
  | Readonly<{
      envelopeAuthorship: "authored";
      autonomousWorkoutProposals: "available";
      envelopeValues: EnvelopeValues;
      promptSkillKey: string;
      toolSelectionRule: string;
    }>;

export const CYCLING_PRESCRIPTION_CAPABILITY = {
  envelopeAuthorship: "unauthored",
  autonomousWorkoutProposals: "unavailable",
  envelopeValues: null,
  promptSkillKey: "cycling-prescription-posture",
  toolSelectionRule:
    "Use build_plan_skeleton and get_sample_week only when the athlete's current message explicitly asks for a cycling workout or plan or a change to one. Use intervals_create_workout only when the current message explicitly asks to create, schedule, push, or update a calendar workout; a prose-only workout request does not authorize a calendar write. An earlier-turn request does not carry forward.",
} as const satisfies PrescriptionCapability<never>;
