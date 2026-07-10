'use strict';

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { app } = require('electron');

const AUDIT_LOG_FILE = 'agent-audit.log';
const AUDIT_HEAD_FILE = 'agent-audit.head';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function auditLogPath() {
  return path.join(app.getPath('userData'), AUDIT_LOG_FILE);
}

function auditHeadPath() {
  return path.join(app.getPath('userData'), AUDIT_HEAD_FILE);
}

async function appendAuditEvent(event) {
  const ts = new Date().toISOString();
  const prevHash = (await fs.readFile(auditHeadPath(), 'utf8').catch(() => '')).trim() || 'GENESIS';
  const payload = {
    ts,
    prev_hash: prevHash,
    ...event,
  };
  const hash = sha256(JSON.stringify(payload));
  const line = JSON.stringify({
    ...payload,
    hash,
  });

  await fs.mkdir(path.dirname(auditLogPath()), { recursive: true });
  await fs.appendFile(auditLogPath(), `${line}\n`, 'utf8');
  await fs.writeFile(auditHeadPath(), hash, 'utf8');
}

module.exports = {
  AUDIT_LOG_FILE,
  AUDIT_HEAD_FILE,
  sha256,
  auditLogPath,
  auditHeadPath,
  appendAuditEvent,
};
