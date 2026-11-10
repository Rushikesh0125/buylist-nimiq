ALTER TABLE personal_nim_savings ADD COLUMN schedule_usd_rate REAL CHECK (schedule_usd_rate > 0);
