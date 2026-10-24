// Minimal in-memory stand-in for the `vscode` module, aliased in via
// vitest.config.ts so the Comments API adapter can be unit-tested without the
// Extension Host. Only the surface used by commentsController.ts is modeled.

export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(
    public readonly startLine: number,
    public readonly startCol: number,
    public readonly endLine: number,
    public readonly endCol: number,
  ) {
    this.start = { line: startLine, character: startCol };
    this.end = { line: endLine, character: endCol };
  }
}

export class MarkdownString {
  constructor(public readonly value: string) {}
}

export const CommentMode = { Editing: 0, Preview: 1 } as const;
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 } as const;

export interface MockThread {
  uri: unknown;
  range: unknown;
  comments: unknown[];
  label?: string;
  collapsibleState?: number;
  disposed: boolean;
  dispose(): void;
}

export interface MockDocument {
  uri: { _rel: string };
  getText(): string;
}

export const state: {
  createdThreads: MockThread[];
  controllerDisposed: boolean;
  textDocuments: MockDocument[];
  workspaceFolders: Array<{ uri: { _rel: string } }>;
  messages: Array<{ severity: 'info' | 'warning' | 'error'; message: string; items: string[] }>;
  // Scripted reply for the next message with action buttons (undefined = dismiss).
  messageResponse: (message: string, items: string[]) => string | undefined;
  shownDocuments: Array<{ doc: MockDocument; options?: { selection?: Range } }>;
  commandRegistry: Map<string, (...args: unknown[]) => unknown>;
} = {
  createdThreads: [],
  controllerDisposed: false,
  textDocuments: [],
  workspaceFolders: [],
  messages: [],
  messageResponse: () => undefined,
  shownDocuments: [],
  commandRegistry: new Map(),
};

export function __reset(): void {
  state.createdThreads = [];
  state.controllerDisposed = false;
  state.textDocuments = [];
  state.workspaceFolders = [{ uri: { _rel: '' } }];
  state.messages = [];
  state.messageResponse = () => undefined;
  state.shownDocuments = [];
  state.commandRegistry = new Map();
}

export const comments = {
  createCommentController() {
    return {
      commentingRangeProvider: undefined as unknown,
      createCommentThread(uri: unknown, range: unknown, comments: unknown[]): MockThread {
        const t: MockThread = {
          uri,
          range,
          comments,
          disposed: false,
          dispose() {
            this.disposed = true;
          },
        };
        state.createdThreads.push(t);
        return t;
      },
      dispose() {
        state.controllerDisposed = true;
      },
    };
  },
};

export const workspace = {
  get textDocuments() {
    return state.textDocuments;
  },
  get workspaceFolders() {
    return state.workspaceFolders;
  },
  asRelativePath(uri: { _rel: string }) {
    return uri._rel;
  },
  // Mock semantics: only documents in state.textDocuments "exist on disk".
  async openTextDocument(uri: { _rel: string }): Promise<MockDocument> {
    const doc = state.textDocuments.find((d) => d.uri._rel === uri._rel);
    if (!doc) throw new Error(`cannot open file ${uri._rel}`);
    return doc;
  },
};

const pushMessage = (
  severity: 'info' | 'warning' | 'error',
  message: string,
  items: string[],
): Promise<string | undefined> => {
  state.messages.push({ severity, message, items });
  return Promise.resolve(state.messageResponse(message, items));
};

export const window = {
  createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
  showInformationMessage: (message: string, ...items: string[]) =>
    pushMessage('info', message, items),
  showWarningMessage: (message: string, ...items: string[]) =>
    pushMessage('warning', message, items),
  showErrorMessage: (message: string, ...items: string[]) =>
    pushMessage('error', message, items),
  async showTextDocument(doc: MockDocument, options?: { selection?: Range }): Promise<void> {
    state.shownDocuments.push({ doc, options });
  },
};

export const commands = {
  registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
    state.commandRegistry.set(id, fn);
    return { dispose() {} };
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const fn = state.commandRegistry.get(id);
    if (!fn) throw new Error(`command not registered: ${id}`);
    return fn(...args);
  },
};

export const Uri = {
  joinPath(_base: { _rel: string }, ...parts: string[]) {
    return { _rel: parts.join('/') };
  },
};

export class EventEmitter<T = void> {
  private listeners: Array<(e: T) => void> = [];
  event = (fn: (e: T) => void) => {
    this.listeners.push(fn);
    return { dispose() {} };
  };
  fire(e: T): void {
    for (const fn of this.listeners) fn(e);
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class TreeItem {
  id?: string;
  label: string;
  description?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    label: string,
    public collapsibleState: number = TreeItemCollapsibleState.None,
  ) {
    this.label = label;
  }
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: unknown,
  ) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export const l10n = { t: (message: string) => message };
