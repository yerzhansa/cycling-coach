import type { MemorySectionSpec } from "../sport.js";

/**
 * The truly-universal sections that any endurance athlete carries
 * regardless of sport. Sport packages declare additional sport-prefixed
 * sections (e.g. cycling-profile, running-profile). Per ADR-0003.
 */
export const CORE_SHARED_SECTIONS: readonly MemorySectionSpec[] = [
  {
    name: "person",
    description:
      "Name, weight (kg), age, available training days per week. " +
      "Sport-specific physiology (FTP, VDOT, max HR) goes to the sport-prefixed profile section.",
  },
  {
    name: "schedule",
    description: "Weekly training availability, time windows, blackout days",
  },
  {
    name: "goals",
    description:
      "Target events, race dates, fitness targets, milestones " +
      "(e.g., 'sub-3:30 century in October', 'reach 280W FTP by Q3')",
  },
  {
    name: "preferences",
    description: "Coaching style, training environment, communication preferences",
  },
  {
    name: "notes",
    description: "Anything else important not covered by other sections",
  },
  {
    name: "medical-history",
    description:
      "Chronic conditions, medications, long-term injuries — facts that persist across sports",
  },
];
