export const COACH_EVENT_TAG = "cycling-coach";
export const COACH_EXTERNAL_ID_PREFIX = `${COACH_EVENT_TAG}:`;

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "workout";
}

export function buildCoachExternalId(date: string, name: string): string {
  return `${COACH_EXTERNAL_ID_PREFIX}${date}:${slugifyName(name)}`;
}

export function buildCoachEventProvenance(
  date: string,
  name: string,
): { externalId: string; tags: string[] } {
  return {
    externalId: buildCoachExternalId(date, name),
    tags: [COACH_EVENT_TAG],
  };
}

export function isCoachOwnedEvent(event: {
  tags?: string[] | null;
  externalId?: string | null;
}): boolean {
  if (event.tags?.includes(COACH_EVENT_TAG)) return true;
  if (event.externalId?.startsWith(COACH_EXTERNAL_ID_PREFIX)) return true;
  return false;
}
