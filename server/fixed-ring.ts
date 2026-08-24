/** A fixed-capacity insertion-ordered buffer with O(1) writes. */
export class FixedRing<T> {
  private readonly items: T[] = [];
  private next = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError("FixedRing capacity must be a positive safe integer.");
    }
  }

  push(value: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(value);
      return;
    }
    this.items[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
  }

  values(): T[] {
    if (this.items.length < this.capacity || this.next === 0) return [...this.items];
    const ordered = new Array<T>(this.items.length);
    const tailLength = this.items.length - this.next;
    for (let index = 0; index < tailLength; index += 1) {
      ordered[index] = this.items[this.next + index]!;
    }
    for (let index = 0; index < this.next; index += 1) {
      ordered[tailLength + index] = this.items[index]!;
    }
    return ordered;
  }

  get size(): number {
    return this.items.length;
  }
}
