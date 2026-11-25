import type { Msg } from '../llm/groq.ts';
import type { Store } from '../database/database.ts';

export class Conversation {
  id: number;
  messages: Msg[];
  private store: Store;
  /** Pass an id to resume it; otherwise a new conversation is started. */
  constructor(store: Store, id?: number) {
    this.store = store;
    this.id = id ?? store.create();
    this.messages = id === undefined ? [] : store.load(id);
  }
  add(m: Msg): void {
    this.messages.push(m);
    this.store.append(this.id, m);
  }
}
