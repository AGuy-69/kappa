import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Msg } from '../llm/groq.ts';

/** Conversation history. Messages are stored as the exact JSON sent to the model. */
export class Store {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id),
        msg TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
    `);
  }
  create(): number {
    return Number(this.db.prepare('INSERT INTO conversations (created_at) VALUES (?)').run(new Date().toISOString()).lastInsertRowid);
  }
  latest(): number | undefined {
    const row = this.db.prepare('SELECT max(id) AS id FROM conversations').get() as { id: number | null };
    return row.id ?? undefined;
  }
  append(conversationId: number, m: Msg): void {
    this.db.prepare('INSERT INTO messages (conversation_id, msg) VALUES (?, ?)').run(conversationId, JSON.stringify(m));
  }
  load(conversationId: number): Msg[] {
    const rows = this.db.prepare('SELECT msg FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as { msg: string }[];
    return rows.map((r) => JSON.parse(r.msg));
  }
  close(): void {
    this.db.close();
  }
}
