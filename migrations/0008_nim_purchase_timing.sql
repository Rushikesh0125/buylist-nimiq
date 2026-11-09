ALTER TABLE personal_nim_savings ADD COLUMN purchase_date TEXT;
ALTER TABLE personal_nim_savings ADD COLUMN final_contribution_luna INTEGER NOT NULL DEFAULT 0 CHECK (final_contribution_luna >= 0);
