import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "./download-store.js";
import type { SearchResult } from "../types/search.js";

const RESULT_FILE = path.join(STATE_DIR, "last-results.json");

export class ResultStore {
  private readonly file: string;
  /** Serialise writes so concurrent searches cannot interleave a rename. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file ?? RESULT_FILE;
  }

  async save(results: SearchResult[]): Promise<void> {
    const payload = JSON.stringify(results.slice(0, 100));
    const work = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, this.file);
    });
    this.writeQueue = work.catch(() => undefined);
    await work;
  }

  async get(index: number): Promise<SearchResult | undefined> {
    try {
      const results = JSON.parse(await readFile(this.file, "utf8")) as SearchResult[];
      return results[index - 1];
    } catch {
      return undefined;
    }
  }
}
