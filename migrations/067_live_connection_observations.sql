-- Registration and projected progress do not establish a current connection.
-- Legacy observations deliberately remain unknown until a new structured probe.
ALTER TABLE live_supervisor_cursors ADD COLUMN connected INTEGER CHECK(connected IN (0,1));
