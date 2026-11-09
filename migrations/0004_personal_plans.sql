CREATE TABLE personal_plans (
  goal_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  frequency TEXT NOT NULL CHECK(frequency IN ('weekly','fortnightly','monthly')),
  start_date TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(goal_id,user_id),
  FOREIGN KEY(goal_id,user_id) REFERENCES memberships(goal_id,user_id) ON DELETE CASCADE
);
