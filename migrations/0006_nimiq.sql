CREATE TABLE nimiq_signin (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX nimiq_signin_expiry ON nimiq_signin(expires_at);

CREATE TABLE nimiq_goals (
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  recipient TEXT NOT NULL,
  target_luna INTEGER NOT NULL CHECK (target_luna > 0)
);

CREATE TABLE nimiq_contributions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES nimiq_goals(goal_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  amount_luna INTEGER NOT NULL CHECK (amount_luna > 0),
  accounts_json TEXT NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'canceled')),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX nimiq_confirmed_hash
ON nimiq_contributions(network, tx_hash) WHERE status = 'confirmed';
CREATE UNIQUE INDEX nimiq_one_pending
ON nimiq_contributions(goal_id, user_id) WHERE status = 'pending';
CREATE INDEX nimiq_contributions_goal ON nimiq_contributions(goal_id, status);
