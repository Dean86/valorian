/**
 * Node dev shims — run the exact same Hono app outside Cloudflare:
 *  - SqliteD1: a minimal D1Database adapter over node:sqlite (Node >= 22.5,
 *    NODE_OPTIONS=--experimental-sqlite). Implements only what the app uses:
 *    prepare().bind().run()/first()/all().
 *  - MemoryKV: a Map-backed KVNamespace subset (get "json" / put).
 * Local dev + demos only; production uses real D1/KV bindings.
 */

import { DatabaseSync } from "node:sqlite";

export class SqliteD1 {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string) {
    const db = this.db;
    const make = (args: unknown[]) => ({
      async run() {
        db.prepare(sql).run(...(args as never[]));
        return { success: true } as const;
      },
      async first<T>() {
        return (db.prepare(sql).get(...(args as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...(args as never[])) as T[] };
      },
    });
    return {
      bind: (...args: unknown[]) => make(args),
      ...make([]),
    };
  }
}

export class MemoryKV {
  private store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const v = this.store.get(key) ?? null;
    if (v === null) return null;
    return type === "json" ? JSON.parse(v) : v;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}
