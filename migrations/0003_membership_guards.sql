CREATE TRIGGER fixed_membership_locked BEFORE INSERT ON memberships
WHEN NEW.role='member' AND EXISTS(SELECT 1 FROM goals WHERE id=NEW.goal_id AND mode='fixed')
AND EXISTS(SELECT 1 FROM commitments WHERE goal_id=NEW.goal_id)
BEGIN SELECT RAISE(ABORT,'FIXED_MEMBERSHIP_LOCKED'); END;
CREATE TRIGGER membership_goal_version AFTER INSERT ON memberships
BEGIN UPDATE goals SET version=version+1 WHERE id=NEW.goal_id; END;
