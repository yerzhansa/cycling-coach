ALTER TABLE plan_conversation
  ADD COLUMN course_choice_status TEXT NOT NULL DEFAULT 'undecided'
  CHECK (course_choice_status IN ('undecided','omitted','attached'));

ALTER TABLE plan_conversation
  ADD COLUMN race_course_json TEXT
  CHECK (race_course_json IS NULL OR json_valid(race_course_json));

ALTER TABLE plan_draft_revision
  ADD COLUMN race_course_json TEXT
  CHECK (race_course_json IS NULL OR json_valid(race_course_json));
