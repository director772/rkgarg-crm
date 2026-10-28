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
