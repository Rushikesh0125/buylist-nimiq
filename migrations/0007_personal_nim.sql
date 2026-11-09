CREATE TABLE personal_nim_savings (
  goal_id TEXT NOT NULL REFERENCES goals(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  address TEXT NOT NULL,
  target_luna INTEGER NOT NULL CHECK (target_luna > 0),
  earmarked_luna INTEGER NOT NULL CHECK (earmarked_luna >= 0 AND earmarked_luna <= target_luna),
  review_date TEXT,
  PRIMARY KEY (goal_id, user_id, network)
);

CREATE INDEX personal_nim_wallet ON personal_nim_savings(user_id, network, address);
