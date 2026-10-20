export interface HistoryEntry {
  label: string;
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
}

class HistoryStore {
  private stack: HistoryEntry[] = [];
  private index = -1;
  private listeners = new Set<() => void>();

  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  get undoLabel() { return this.index >= 0 ? this.stack[this.index].label : ''; }
  get redoLabel() { return this.index < this.stack.length - 1 ? this.stack[this.index + 1].label : ''; }

  push(entry: HistoryEntry) {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(entry);
    if (this.stack.length > 60) this.stack.shift();
    this.index = this.stack.length - 1;
    this.emit();
  }

  async undo() {
    if (!this.canUndo) return;
    const e = this.stack[this.index];
    await e.undo();
    this.index--;
    this.emit();
    return e.label;
  }

  async redo() {
    if (!this.canRedo) return;
    const e = this.stack[this.index + 1];
    await e.redo();
    this.index++;
    this.emit();
    return e.label;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() { for (const l of this.listeners) l(); }
}

export const history = new HistoryStore();
