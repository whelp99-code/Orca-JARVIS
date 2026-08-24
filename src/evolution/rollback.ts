import { JarvisError } from "../db.js";

export class ProductionPointer {
  private current: string | undefined;
  private previous: string | undefined;

  promote(id: string): void {
    this.previous = this.current;
    this.current = id;
  }

  rollback(): string {
    if (!this.previous) throw new JarvisError("EVOLUTION_NO_ROLLBACK");
    const restored = this.previous;
    this.current = restored;
    this.previous = undefined;
    return restored;
  }

  get pointer(): string | undefined {
    return this.current;
  }
}
