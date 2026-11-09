CREATE TABLE automatic_plans (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, user_id TEXT NOT NULL,
 authorization_key TEXT NOT NULL UNIQUE, setup_id TEXT UNIQUE, token_id TEXT,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 target_cents INTEGER NOT NULL CHECK(target_cents>0), limit_cents INTEGER NOT NULL CHECK(limit_cents>0),
 frequency TEXT NOT NULL CHECK(frequency IN ('weekly','fortnightly','monthly')),
 start_date TEXT NOT NULL, timezone TEXT NOT NULL,
 next_index INTEGER NOT NULL DEFAULT 0, next_date TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','active','paused','cancelled','finished')),
 reason TEXT, consent_version TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(goal_id,user_id), FOREIGN KEY(goal_id,user_id) REFERENCES memberships(goal_id,user_id)
);
CREATE INDEX automatic_due ON automatic_plans(state,next_date);
CREATE TABLE automatic_authorizations (
 authorization_key TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES automatic_plans(id),
 terms_json TEXT NOT NULL, created_at INTEGER NOT NULL, approved_at INTEGER, cancelled_at INTEGER
);
CREATE TABLE automatic_cycles (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES automatic_plans(id),
 cycle_index INTEGER NOT NULL, authorization_key TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
 attempt_id TEXT REFERENCES payment_attempts(id), created_at INTEGER NOT NULL,
 UNIQUE(plan_id,authorization_key,cycle_index)
);
CREATE TABLE refund_requests (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
 user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), provider_id TEXT UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('created','pending','completed','failed')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id,request_key)
);
CREATE INDEX refunds_attempt ON refund_requests(attempt_id,state);
