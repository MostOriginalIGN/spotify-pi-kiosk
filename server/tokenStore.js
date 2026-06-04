import fs from "node:fs/promises";
import path from "node:path";

export class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    try {
      const body = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(body);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(tokens) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(tokens, null, 2), {
      mode: 0o600
    });
  }

  async clear() {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
