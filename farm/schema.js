'use strict';

const { randomUUID } = require('node:crypto');
const { fail, DOCUMENT_TYPES } = require('./validation');
const SCHEMA_VERSION = 1;
const TABLES = Object.freeze(['operator', 'facility', 'lots', 'lot_corrections', 'customers', 'shipments', 'shipment_items', 'logs', 'documents', 'document_revisions', 'audit']);
const SAFE = 9007199254740991;
const SCHEMA = `
CREATE TABLE operator (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 500)) STRICT;
CREATE TABLE facility (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_name TEXT NOT NULL, address TEXT NOT NULL,
 emergency_phone TEXT NOT NULL, water_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_facility ON facility((1));
CREATE UNIQUE INDEX one_operator ON operator((1));
CREATE TABLE lots (
 id TEXT PRIMARY KEY, lot_code TEXT NOT NULL UNIQUE, harvest_date TEXT NOT NULL, room TEXT NOT NULL, species TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND ${SAFE}), notes TEXT NOT NULL, created_at TEXT NOT NULL,
 source_id TEXT UNIQUE, source_snapshot TEXT CHECK(source_snapshot IS NULL OR json_valid(source_snapshot)),
 source_reviewer TEXT CHECK(source_reviewer IS NULL OR json_valid(source_reviewer)), source_approved_at TEXT,
 source_hash TEXT, original_record TEXT NOT NULL CHECK(json_valid(original_record)),
 CHECK((source_id IS NULL AND source_snapshot IS NULL AND source_reviewer IS NULL AND source_approved_at IS NULL AND source_hash IS NULL)
 OR (source_id IS NOT NULL AND source_snapshot IS NOT NULL AND source_reviewer IS NOT NULL AND source_approved_at IS NOT NULL
 AND source_hash IS NOT NULL AND length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'
 AND json_type(source_snapshot,'$.id')='text' AND source_id='legacy-flush:'||json_extract(source_snapshot,'$.id')))
) STRICT;
CREATE TABLE lot_corrections (
 id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES lots(id), version INTEGER NOT NULL CHECK(version>=2),
 harvest_date TEXT NOT NULL, room TEXT NOT NULL, species TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND ${SAFE}), notes TEXT NOT NULL,
 before_record TEXT NOT NULL CHECK(json_valid(before_record)), after_record TEXT NOT NULL CHECK(json_valid(after_record)),
 actor TEXT NOT NULL CHECK(json_valid(actor)), timestamp TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 5000),
 UNIQUE(lot_id,version)
) STRICT;
CREATE TABLE customers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE shipments (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 customer_id TEXT NOT NULL REFERENCES customers(id), customer_snapshot TEXT NOT NULL CHECK(json_valid(customer_snapshot)),
 shipped_at TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE shipment_items (
 shipment_id TEXT NOT NULL REFERENCES shipments(id), position INTEGER NOT NULL CHECK(position>=0), lot_id TEXT NOT NULL REFERENCES lots(id),
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND ${SAFE}), lot_code TEXT NOT NULL, lot_snapshot TEXT NOT NULL CHECK(json_valid(lot_snapshot)),
 PRIMARY KEY(shipment_id,lot_id), UNIQUE(shipment_id,position)
) STRICT;
CREATE INDEX shipment_lot ON shipment_items(lot_id);
CREATE TABLE logs (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=1), logged_at TEXT NOT NULL, room TEXT NOT NULL,
 temperature_f REAL CHECK(temperature_f BETWEEN -100 AND 250), humidity_percent REAL CHECK(humidity_percent BETWEEN 0 AND 100),
 cleaning_completed INTEGER NOT NULL CHECK(cleaning_completed IN(0,1)), lot_id TEXT REFERENCES lots(id),
 deviation_notes TEXT NOT NULL, corrective_action TEXT NOT NULL, deviation_status TEXT NOT NULL CHECK(deviation_status IN('NONE','OPEN','RESOLVED')),
 resolved_at TEXT, resolved_by TEXT CHECK(resolved_by IS NULL OR json_valid(resolved_by)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((deviation_status='NONE' AND length(trim(deviation_notes))=0 AND resolved_at IS NULL AND resolved_by IS NULL)
 OR (deviation_status='OPEN' AND length(trim(deviation_notes))>0 AND resolved_at IS NULL AND resolved_by IS NULL)
 OR (deviation_status='RESOLVED' AND length(trim(deviation_notes))>0 AND length(trim(corrective_action))>0 AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
) STRICT;
CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN(${DOCUMENT_TYPES.map(x => `'${x}'`).join(',')}))) STRICT;
CREATE TABLE document_revisions (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL CHECK(version>=1),
 edit_version INTEGER NOT NULL CHECK(edit_version>=1), title TEXT NOT NULL, content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 100000),
 status TEXT NOT NULL CHECK(status IN('DRAFT','NEEDS_REVIEW','APPROVED','SUPERSEDED')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT, approved_at TEXT,
 approved_by TEXT CHECK(approved_by IS NULL OR json_valid(approved_by)), content_hash TEXT,
 supersedes_revision_id TEXT REFERENCES document_revisions(id), superseded_by_revision_id TEXT REFERENCES document_revisions(id),
 UNIQUE(document_id,version),
 CHECK((status IN('DRAFT','NEEDS_REVIEW') AND approved_at IS NULL AND approved_by IS NULL AND content_hash IS NULL AND superseded_by_revision_id IS NULL)
 OR (status IN('APPROVED','SUPERSEDED') AND submitted_at IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL
 AND content_hash IS NOT NULL AND length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*')),
 CHECK((status='SUPERSEDED' AND superseded_by_revision_id IS NOT NULL) OR (status!='SUPERSEDED' AND superseded_by_revision_id IS NULL)),
 CHECK(status!='NEEDS_REVIEW' OR submitted_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX one_approved ON document_revisions(document_id) WHERE status='APPROVED';
CREATE UNIQUE INDEX one_pending ON document_revisions(document_id) WHERE status IN('DRAFT','NEEDS_REVIEW');
CREATE TABLE audit (
 sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, entity_id TEXT NOT NULL, action TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(json_valid(actor)), timestamp TEXT NOT NULL, reason TEXT NOT NULL,
 before_record TEXT CHECK(before_record IS NULL OR json_valid(before_record)), after_record TEXT NOT NULL CHECK(json_valid(after_record)),
 command TEXT NOT NULL CHECK(json_valid(command))
) STRICT;
CREATE INDEX audit_entity ON audit(entity_id,sequence);
CREATE TRIGGER correction_sequence BEFORE INSERT ON lot_corrections BEGIN
 SELECT CASE WHEN NEW.version != COALESCE((SELECT MAX(version)+1 FROM lot_corrections WHERE lot_id=NEW.lot_id),2) THEN RAISE(ABORT,'correction version conflict') END;
 SELECT CASE WHEN NEW.quantity < COALESCE((SELECT SUM(quantity) FROM shipment_items WHERE lot_id=NEW.lot_id),0) THEN RAISE(ABORT,'quantity below shipped') END;
END;
CREATE TRIGGER shipment_allocation BEFORE INSERT ON shipment_items BEGIN
 SELECT CASE WHEN NEW.quantity > COALESCE((SELECT quantity FROM lot_corrections WHERE lot_id=NEW.lot_id ORDER BY version DESC LIMIT 1),(SELECT quantity FROM lots WHERE id=NEW.lot_id))
 - COALESCE((SELECT SUM(quantity) FROM shipment_items WHERE lot_id=NEW.lot_id),0) THEN RAISE(ABORT,'insufficient quantity') END;
 SELECT CASE WHEN NEW.lot_code != (SELECT lot_code FROM lots WHERE id=NEW.lot_id) THEN RAISE(ABORT,'lot code mismatch') END;
END;
CREATE TRIGGER log_version BEFORE UPDATE ON logs BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.created_at!=OLD.created_at OR NEW.version!=OLD.version+1 THEN RAISE(ABORT,'log version conflict') END;
 SELECT CASE WHEN OLD.deviation_status!='NONE' AND NEW.deviation_status='NONE' THEN RAISE(ABORT,'existing deviation cannot be erased') END;
 SELECT CASE WHEN OLD.deviation_status='NONE' AND NEW.deviation_status='RESOLVED' THEN RAISE(ABORT,'deviation must first be opened') END;
END;
CREATE TRIGGER revision_version BEFORE UPDATE ON document_revisions BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.document_id!=OLD.document_id OR NEW.version!=OLD.version OR NEW.created_at!=OLD.created_at OR NEW.edit_version!=OLD.edit_version+1 THEN RAISE(ABORT,'revision version conflict') END;
 SELECT CASE WHEN OLD.status='DRAFT' AND NEW.status NOT IN('DRAFT','NEEDS_REVIEW') THEN RAISE(ABORT,'draft must first be reviewed') END;
 SELECT CASE WHEN OLD.status='NEEDS_REVIEW' AND NEW.status NOT IN('DRAFT','APPROVED') THEN RAISE(ABORT,'invalid review transition') END;
 SELECT CASE WHEN NEW.status='APPROVED' AND (NEW.title!=OLD.title OR NEW.content!=OLD.content OR NEW.submitted_at IS NOT OLD.submitted_at) THEN RAISE(ABORT,'reviewed content cannot change during approval') END;
END;
CREATE TRIGGER approved_immutable BEFORE UPDATE ON document_revisions WHEN OLD.status IN('APPROVED','SUPERSEDED') BEGIN
 SELECT CASE WHEN NOT (
 OLD.status='APPROVED' AND NEW.status='SUPERSEDED' AND NEW.superseded_by_revision_id IS NOT NULL
 AND NEW.id=OLD.id AND NEW.document_id=OLD.document_id AND NEW.version=OLD.version AND NEW.edit_version=OLD.edit_version+1
 AND NEW.title=OLD.title AND NEW.content=OLD.content AND NEW.created_at=OLD.created_at
 AND NEW.submitted_at IS OLD.submitted_at AND NEW.approved_at IS OLD.approved_at AND NEW.approved_by IS OLD.approved_by
 AND NEW.content_hash IS OLD.content_hash AND NEW.supersedes_revision_id IS OLD.supersedes_revision_id
 AND EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=NEW.superseded_by_revision_id AND r.document_id=OLD.document_id AND r.version>OLD.version AND r.status='NEEDS_REVIEW')
 ) THEN RAISE(ABORT,'approved revision is immutable') END;
END;
`;

function initialize(db) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const version = () => db.prepare('PRAGMA user_version').get().user_version;
  const initial = version();
  if (initial !== 0 && initial !== SCHEMA_VERSION) fail('CORRUPT_STORE', `Unsupported farm schema version ${initial}. No migration was performed.`);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
  try {
    // Check only after taking the writer lock: another connection may have
    // completed first-time initialization since our initial version read.
    if (version() === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) fail('CORRUPT_STORE', 'Unrecognized unversioned farm database.');
      db.exec(SCHEMA);
      for (const table of TABLES) {
        db.exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'farm history cannot be deleted'); END;`);
      }
      for (const table of ['lots', 'lot_corrections', 'customers', 'shipments', 'shipment_items', 'audit']) {
        db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'farm history is immutable'); END;`);
      }
      db.prepare('INSERT INTO operator(id,name) VALUES(?,?)').run('operator_' + randomUUID(), 'Local operator');
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
    } else if (version() !== SCHEMA_VERSION) fail('CORRUPT_STORE', 'Unsupported farm schema version.');
    for (const table of TABLES) db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) fail('CORRUPT_STORE', 'Farm database integrity check failed.');
    if (db.prepare('SELECT COUNT(*) AS n FROM operator').get().n !== 1) fail('CORRUPT_STORE', 'Farm operator identity is missing.');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = { initialize, SCHEMA_VERSION, TABLES };
