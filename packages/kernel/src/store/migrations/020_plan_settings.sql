CREATE TABLE plan_settings (
  plan_id TEXT PRIMARY KEY REFERENCES plan(id) ON DELETE CASCADE,
  auto_apply INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply IN (0, 1)),
  weekly_review INTEGER NOT NULL DEFAULT 1 CHECK (weekly_review IN (0, 1)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
) STRICT;

INSERT INTO plan_settings (
  plan_id, auto_apply, weekly_review, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
)
SELECT id, 0, 1, updated_at_ms, device_id, hlc_physical_ms, hlc_counter FROM plan;

CREATE TRIGGER plan_settings_defaults_after_insert
AFTER INSERT ON plan
BEGIN
  INSERT INTO plan_settings (
    plan_id, auto_apply, weekly_review, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
  ) VALUES (
    NEW.id, 0, 1, NEW.updated_at_ms, NEW.device_id, NEW.hlc_physical_ms, NEW.hlc_counter
  );
END;
