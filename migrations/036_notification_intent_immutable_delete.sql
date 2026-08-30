CREATE TRIGGER notification_intents_immutable_delete BEFORE DELETE ON notification_intents BEGIN SELECT RAISE(ABORT,'immutable notification intent'); END;
