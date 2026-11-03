-- Smart CRM — Cloudflare D1 database
-- Column names match the Google Sheet headers exactly (easy Sheet <-> App sync).
-- Safe to run again: only creates what is missing.

CREATE TABLE IF NOT EXISTS Leads (
  ID TEXT PRIMARY KEY,
  Name TEXT DEFAULT '',
  Mobile TEXT NOT NULL,
  City TEXT DEFAULT '',
  Source TEXT DEFAULT '',
  Product TEXT DEFAULT '',
  CRM TEXT DEFAULT '',
  Status TEXT DEFAULT '',
  Disposition TEXT DEFAULT '',
  Score INTEGER DEFAULT 0,
  LastCallAt TEXT DEFAULT '',
  NextActionType TEXT DEFAULT '',
  NextFollowupAt TEXT DEFAULT '',
  Note TEXT DEFAULT '',
  CreatedAt TEXT DEFAULT '',
  CreatedBy TEXT DEFAULT '',
  LastUpdatedAt TEXT DEFAULT '',
  LastUpdatedBy TEXT DEFAULT '',
  RowVersion INTEGER DEFAULT 1,
  LastReq TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS Leads_Mobile ON Leads(Mobile);
CREATE INDEX IF NOT EXISTS Leads_CRM ON Leads(CRM);

CREATE TABLE IF NOT EXISTS CallLog (
  ID TEXT PRIMARY KEY,
  LeadID TEXT DEFAULT '',
  CallDate TEXT DEFAULT '',
  Response TEXT DEFAULT '',
  NextActionType TEXT DEFAULT '',
  NextFollowupAt TEXT DEFAULT '',
  Note TEXT DEFAULT '',
  CreatedBy TEXT DEFAULT '',
  CreatedAt TEXT DEFAULT '',
  CRM TEXT DEFAULT '',
  UpdatedAt TEXT DEFAULT '',
  UpdatedBy TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS CallLog_LeadID ON CallLog(LeadID);
CREATE INDEX IF NOT EXISTS CallLog_CallDate ON CallLog(CallDate);

CREATE TABLE IF NOT EXISTS Users (
  Username TEXT PRIMARY KEY,
  PasswordHash TEXT DEFAULT '',
  Salt TEXT DEFAULT '',
  DisplayName TEXT DEFAULT '',
  Role TEXT DEFAULT '',
  TeamMemberName TEXT DEFAULT '',
  Active INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Team (
  Name TEXT PRIMARY KEY,
  Active INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Visits (
  ID TEXT PRIMARY KEY,
  LeadID TEXT DEFAULT '',
  CRM TEXT DEFAULT '',
  PlannedDate TEXT DEFAULT '',
  Status TEXT DEFAULT '',
  ActualAt TEXT DEFAULT '',
  Note TEXT DEFAULT '',
  Version INTEGER DEFAULT 1,
  UpdatedAt TEXT DEFAULT '',
  UpdatedBy TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS Visits_LeadID ON Visits(LeadID);

CREATE TABLE IF NOT EXISTS LegacyReview (
  ID TEXT PRIMARY KEY,
  Name TEXT DEFAULT '',
  Mobile TEXT DEFAULT '',
  RowsFound INTEGER DEFAULT 0,
  LastKnownDisposition TEXT DEFAULT '',
  LastKnownDate TEXT DEFAULT '',
  Details TEXT DEFAULT '',
  Status TEXT DEFAULT '',
  ResolvedBy TEXT DEFAULT '',
  ResolvedAt TEXT DEFAULT '',
  ImportBatchID TEXT DEFAULT '',
  ImportSource TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS LegacyReview_Mobile ON LegacyReview(Mobile);

CREATE TABLE IF NOT EXISTS LegacyImportBatches (
  BatchID TEXT PRIMARY KEY,
  Fingerprint TEXT DEFAULT '',
  SourceHash TEXT DEFAULT '',
  CreatedAt TEXT DEFAULT '',
  CreatedBy TEXT DEFAULT '',
  Status TEXT DEFAULT '',
  HeaderJSON TEXT DEFAULT '',
  TotalRows INTEGER DEFAULT 0,
  UniqueMobiles INTEGER DEFAULT 0,
  InvalidMobiles INTEGER DEFAULT 0,
  ResultJSON TEXT DEFAULT '',
  UpdatedAt TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS LegacyImportBatches_Fp ON LegacyImportBatches(Fingerprint);

CREATE TABLE IF NOT EXISTS LegacyImportRows (
  RecordKey TEXT PRIMARY KEY,
  BatchID TEXT DEFAULT '',
  CSVRow INTEGER DEFAULT 0,
  Mobile TEXT DEFAULT '',
  Name TEXT DEFAULT '',
  Disposition TEXT DEFAULT '',
  SourceDate TEXT DEFAULT '',
  ValidMobile INTEGER DEFAULT 0,
  Issue TEXT DEFAULT '',
  RawJSON TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS LegacyImportRows_Batch ON LegacyImportRows(BatchID);

CREATE TABLE IF NOT EXISTS AuditLog (
  Seq INTEGER PRIMARY KEY AUTOINCREMENT,
  Timestamp TEXT DEFAULT '',
  User TEXT DEFAULT '',
  Action TEXT DEFAULT '',
  EntityType TEXT DEFAULT '',
  EntityID TEXT DEFAULT '',
  Details TEXT DEFAULT ''
);

-- Each save is recorded once: a retry with the same request ID returns the
-- first result and never creates a second entry.
CREATE TABLE IF NOT EXISTS Requests (
  RequestID TEXT PRIMARY KEY,
  Action TEXT DEFAULT '',
  User TEXT DEFAULT '',
  Fingerprint TEXT DEFAULT '',
  Result TEXT DEFAULT '',
  CreatedAt TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Sessions (
  Token TEXT PRIMARY KEY,
  Username TEXT NOT NULL,
  Fingerprint TEXT NOT NULL,
  ExpiresAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS LoginAttempts (
  Key TEXT PRIMARY KEY,
  Count INTEGER DEFAULT 0,
  Until INTEGER DEFAULT 0
);

-- Used to cancel a save safely: inserting NULL here fails and rolls back
-- the whole save when its safety check does not pass.
CREATE TABLE IF NOT EXISTS SaveGuard (
  V TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Meta (
  Key TEXT PRIMARY KEY,
  Value TEXT DEFAULT ''
);

-- New customers (no call yet) are shown to every CRM. A CRM who has one on screen
-- "holds" it for a few minutes so two people don't phone the same customer.
CREATE TABLE IF NOT EXISTS LeadClaims (
  LeadID TEXT PRIMARY KEY,
  CRM TEXT NOT NULL,
  Until INTEGER NOT NULL
);

-- Change counter per Sheet tab. The 5-minute Sheet sync asks for these
-- (a few rows) and only re-sends a tab when its counter moved. This keeps
-- the database's daily "rows read" far below the free limit.
CREATE TABLE IF NOT EXISTS SyncVer (
  Tab TEXT PRIMARY KEY,
  V INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO SyncVer (Tab, V) VALUES ('Leads',1),('CallLog',1),('Users',1),('Team',1),('CRM Visits',1),('LegacyReview',1),('LegacyImportBatches',1),('LegacyImportRows',1),('AuditLog',1);
CREATE TRIGGER IF NOT EXISTS SyncVer_Leads_insert AFTER INSERT ON Leads BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Leads'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Leads_update AFTER UPDATE ON Leads BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Leads'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Leads_delete AFTER DELETE ON Leads BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Leads'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_CallLog_insert AFTER INSERT ON CallLog BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='CallLog'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_CallLog_update AFTER UPDATE ON CallLog BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='CallLog'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_CallLog_delete AFTER DELETE ON CallLog BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='CallLog'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Users_insert AFTER INSERT ON Users BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Users'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Users_update AFTER UPDATE ON Users BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Users'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Users_delete AFTER DELETE ON Users BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Users'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Team_insert AFTER INSERT ON Team BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Team'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Team_update AFTER UPDATE ON Team BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Team'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Team_delete AFTER DELETE ON Team BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='Team'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Visits_insert AFTER INSERT ON Visits BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='CRM Visits'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Visits_update AFTER UPDATE ON Visits BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='CRM Visits'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_Visits_delete AFTER DELETE ON Visits BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='CRM Visits'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyReview_insert AFTER INSERT ON LegacyReview BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyReview'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyReview_update AFTER UPDATE ON LegacyReview BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyReview'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyReview_delete AFTER DELETE ON LegacyReview BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyReview'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyImportBatches_insert AFTER INSERT ON LegacyImportBatches BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyImportBatches'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyImportBatches_update AFTER UPDATE ON LegacyImportBatches BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyImportBatches'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyImportBatches_delete AFTER DELETE ON LegacyImportBatches BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyImportBatches'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyImportRows_insert AFTER INSERT ON LegacyImportRows BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyImportRows'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyImportRows_update AFTER UPDATE ON LegacyImportRows BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyImportRows'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_LegacyImportRows_delete AFTER DELETE ON LegacyImportRows BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='LegacyImportRows'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_AuditLog_insert AFTER INSERT ON AuditLog BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='AuditLog'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_AuditLog_update AFTER UPDATE ON AuditLog BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='AuditLog'; END;
CREATE TRIGGER IF NOT EXISTS SyncVer_AuditLog_delete AFTER DELETE ON AuditLog BEGIN UPDATE SyncVer SET V=V+1 WHERE Tab='AuditLog'; END;

-- Which rows changed (one small line per change). The 5-minute Sheet sync asks
-- "what changed after #N?" and gets only those rows — no full-table reads.
-- Lines already delivered to the Sheet are removed.
CREATE TABLE IF NOT EXISTS SyncLog (
  Seq INTEGER PRIMARY KEY AUTOINCREMENT,
  Tab TEXT NOT NULL,
  K TEXT NOT NULL,
  Op TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS SyncLog_Leads_insert AFTER INSERT ON Leads BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Leads', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Leads_update AFTER UPDATE ON Leads BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Leads', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Leads_delete AFTER DELETE ON Leads BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Leads', OLD.ID, 'd'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_CallLog_insert AFTER INSERT ON CallLog BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('CallLog', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_CallLog_update AFTER UPDATE ON CallLog BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('CallLog', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_CallLog_delete AFTER DELETE ON CallLog BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('CallLog', OLD.ID, 'd'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Users_insert AFTER INSERT ON Users BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Users', NEW.Username, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Users_update AFTER UPDATE ON Users BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Users', NEW.Username, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Users_delete AFTER DELETE ON Users BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Users', OLD.Username, 'd'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Team_insert AFTER INSERT ON Team BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Team', NEW.Name, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Team_update AFTER UPDATE ON Team BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Team', NEW.Name, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Team_delete AFTER DELETE ON Team BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('Team', OLD.Name, 'd'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Visits_insert AFTER INSERT ON Visits BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('CRM Visits', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Visits_update AFTER UPDATE ON Visits BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('CRM Visits', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_Visits_delete AFTER DELETE ON Visits BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('CRM Visits', OLD.ID, 'd'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyReview_insert AFTER INSERT ON LegacyReview BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyReview', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyReview_update AFTER UPDATE ON LegacyReview BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyReview', NEW.ID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyReview_delete AFTER DELETE ON LegacyReview BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyReview', OLD.ID, 'd'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyImportBatches_insert AFTER INSERT ON LegacyImportBatches BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyImportBatches', NEW.BatchID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyImportBatches_update AFTER UPDATE ON LegacyImportBatches BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyImportBatches', NEW.BatchID, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyImportBatches_delete AFTER DELETE ON LegacyImportBatches BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyImportBatches', OLD.BatchID, 'd'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyImportRows_insert AFTER INSERT ON LegacyImportRows BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyImportRows', NEW.RecordKey, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyImportRows_update AFTER UPDATE ON LegacyImportRows BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyImportRows', NEW.RecordKey, 'u'); END;
CREATE TRIGGER IF NOT EXISTS SyncLog_LegacyImportRows_delete AFTER DELETE ON LegacyImportRows BEGIN INSERT INTO SyncLog (Tab, K, Op) VALUES ('LegacyImportRows', OLD.RecordKey, 'd'); END;
