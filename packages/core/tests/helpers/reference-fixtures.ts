// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import type { FetchedReference } from "../../src/reference/sync/run-sync.js";

/**
 * Minimal `FetchedReference` shape with empty arrays + empty profile.
 * Use as a base for spies (`vi.fn().mockResolvedValue(emptyFetched)`); spread
 * + override fields for tests that need specific data shapes.
 */
export const emptyFetched: FetchedReference = {
  latest: {
    athlete_profile: {},
    current_status: {},
    derived_metrics: {},
    recent_activities: [],
    planned_workouts: [],
    wellness_data: {},
  },
  history: { daily: [], weekly: [], monthly: [] },
  intervals: { by_activity: {} },
  routes: { routes: [] },
  ftp_history: { entries: [] },
};
