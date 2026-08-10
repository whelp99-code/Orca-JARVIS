CREATE TRIGGER gjc_dispatch_receipts_immutable_delete BEFORE DELETE ON gjc_dispatch_receipts BEGIN SELECT RAISE(ABORT,'immutable gjc dispatch receipt'); END;
CREATE TRIGGER gjc_answer_receipts_immutable_delete BEFORE DELETE ON gjc_answer_receipts BEGIN SELECT RAISE(ABORT,'immutable gjc answer receipt'); END;
