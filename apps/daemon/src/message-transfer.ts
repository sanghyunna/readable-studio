import type Database from 'better-sqlite3';

// The transfer reads substrings from storage, never the aggregating messages view.
const fields = [
  ['id', 'id', 'text'], ['role', 'role', 'text'], ['content', 'content', 'text'],
  ['agent_id', 'agentId', 'text'], ['agent_name', 'agentName', 'text'],
  ['run_id', 'runId', 'text'], ['run_status', 'runStatus', 'text'],
  ['last_run_event_id', 'lastRunEventId', 'text'], ['events_json', 'events', 'json'],
  ['attachments_json', 'attachments', 'json'], ['comment_attachments_json', 'commentAttachments', 'json'],
  ['produced_files_json', 'producedFiles', 'json'], ['feedback_json', 'feedback', 'json'],
  ['pre_turn_file_names_json', 'preTurnFileNames', 'json'], ['session_mode', 'sessionMode', 'text'],
  ['run_context_json', 'runContext', 'json'], ['applied_plugin_snapshot_json', 'appliedPluginSnapshot', 'json'],
  ['created_at', 'createdAt', 'number'], ['started_at', 'startedAt', 'number'], ['ended_at', 'endedAt', 'number'],
] as const;
const CHUNK_BYTES = 32 * 1024;

export function readMessageTransfer(db: Database.Database, messageId: string, cursor: string) {
  const parts = cursor.split(':').map(Number);
  const [index = 0, sequence = 0, offset = 0] = parts;
  if (parts.length !== 3 || parts.some(value => !Number.isSafeInteger(value) || value < 0) || index > fields.length) return null;
  const field = fields[index];
  if (field) {
    const [column, name, encoding] = field;
    const row = db.prepare(`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS data,
      length(CAST(${column} AS BLOB)) AS size FROM message_snapshots WHERE id = ?`)
      .get(offset + 1, CHUNK_BYTES, messageId) as { data: Buffer | null; size: number | null } | undefined;
    if (!row) return null;
    const endField = offset + CHUNK_BYTES >= (row.size ?? 0);
    return { field: name, encoding, data: row.data?.toString('base64') ?? null, endField,
      nextCursor: endField ? `${index + 1}:0:0` : `${index}:0:${offset + CHUNK_BYTES}` };
  }
  const row = db.prepare(`SELECT sequence, substr(CAST(event_json AS BLOB), ?, ?) AS data,
    length(CAST(event_json AS BLOB)) AS size FROM message_event_deltas
    WHERE message_id = ? AND sequence ${offset ? '>=' : '>'} ? ORDER BY sequence LIMIT 1`)
    .get(offset + 1, CHUNK_BYTES, messageId, sequence) as { sequence: number; data: Buffer; size: number } | undefined;
  if (!row) return { field: 'event', encoding: 'json', data: null, endField: true, nextCursor: null };
  const endField = offset + CHUNK_BYTES >= row.size;
  return { field: 'event', encoding: 'json', data: row.data.toString('base64'), endField,
    nextCursor: `${index}:${row.sequence}:${endField ? 0 : offset + CHUNK_BYTES}` };
}
