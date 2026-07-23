import { describe, expect, it, vi } from "vitest";
import {
  createReleaseNotesController,
  type ReleaseNotesResult,
  type ReleaseNotesView,
} from "../src/release-notes/controller.js";
import { createReleaseNotesView } from "../src/release-notes/view.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function available(overrides: Partial<Extract<ReleaseNotesResult, { status: "available" }>> = {}) {
  return {
    status: "available",
    version: "2026.7.23",
    notes: ["Improved Desktop reliability."],
    releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    ...overrides,
  } as const;
}

function fakeView() {
  let handlers:
    | {
        readonly onOpen: () => void;
        readonly onRetry: () => void;
        readonly onClose: () => void;
      }
    | undefined;
  const view: ReleaseNotesView = {
    bind: vi.fn((value) => {
      handlers = value;
    }),
    open: vi.fn(),
    close: vi.fn(),
    renderLoading: vi.fn(),
    renderAvailable: vi.fn(),
    renderUnavailable: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    open: () => handlers?.onOpen(),
    retry: () => handlers?.onRetry(),
    close: () => handlers?.onClose(),
  };
}

describe("release notes controller", () => {
  it("does no startup work, coalesces an active request, and fetches fresh after settlement", async () => {
    const first = deferred<ReleaseNotesResult>();
    const request = vi
      .fn<() => Promise<ReleaseNotesResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(available({ version: "2026.7.24" }));
    const subject = fakeView();
    const controller = createReleaseNotesController({ request, view: subject.view });

    expect(request).not.toHaveBeenCalled();
    const one = controller.activate();
    const two = controller.activate();
    expect(one).toBe(two);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(subject.view.open).toHaveBeenCalledTimes(2);
    expect(subject.view.renderLoading).toHaveBeenCalledOnce();

    first.resolve(available());
    await one;
    expect(subject.view.renderAvailable).toHaveBeenCalledWith(available());

    await controller.activate();
    expect(request).toHaveBeenCalledTimes(2);
    expect(subject.view.renderLoading).toHaveBeenCalledTimes(2);
    expect(subject.view.renderAvailable).toHaveBeenLastCalledWith(
      available({ version: "2026.7.24" }),
    );
  });

  it("renders typed and rejected unavailability without exposing raw errors, then retries", async () => {
    const rawError = new Error("private network detail");
    const request = vi
      .fn<() => Promise<ReleaseNotesResult>>()
      .mockResolvedValueOnce({
        status: "unavailable",
        version: "2026.7.23",
        releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases",
      })
      .mockRejectedValueOnce(rawError);
    const subject = fakeView();
    createReleaseNotesController({ request, view: subject.view });

    subject.open();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(subject.view.renderUnavailable).toHaveBeenLastCalledWith({
        version: "2026.7.23",
        releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases",
      }),
    );
    subject.retry();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(subject.view.renderUnavailable).toHaveBeenLastCalledWith({
        version: null,
        releaseUrl: null,
      }),
    );
    expect(JSON.stringify(vi.mocked(subject.view.renderUnavailable).mock.calls)).not.toContain(
      rawError.message,
    );
  });

  it("ignores late settlement and disposes the view exactly once", async () => {
    const gate = deferred<ReleaseNotesResult>();
    const subject = fakeView();
    const controller = createReleaseNotesController({
      request: vi.fn(() => gate.promise),
      view: subject.view,
    });

    const pending = controller.activate();
    await Promise.resolve();
    controller.dispose();
    controller.dispose();
    gate.resolve(available());
    await pending;

    expect(subject.view.renderAvailable).not.toHaveBeenCalled();
    expect(subject.view.renderUnavailable).not.toHaveBeenCalled();
    expect(subject.view.dispose).toHaveBeenCalledOnce();
    await controller.activate();
    expect(subject.view.open).toHaveBeenCalledOnce();
  });
});

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  parent: FakeElement | undefined;
  className = "";
  disabled = false;
  hidden = false;
  open = false;
  id = "";
  type = "";
  href = "";
  target = "";
  rel = "";
  value = "";
  private ownText = "";

  constructor(
    readonly tagName: string,
    private readonly ownerDocument: FakeDocument,
  ) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }

  insertBefore(node: FakeElement, before: FakeElement | null): void {
    node.remove();
    node.parent = this;
    const index = before === null ? -1 : this.children.indexOf(before);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children.splice(0);
    this.ownText = "";
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "href") this.href = "";
  }

  addEventListener(name: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  click(): void {
    if (this.disabled) return;
    this.dispatch("click");
  }

  dispatch(name: string, event: Event = { preventDefault() {} } as Event): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

class FakeDocument {
  readonly body = new FakeElement("body", this);
  activeElement: FakeElement | null = this.body;

  createElement(name: string): FakeElement {
    return new FakeElement(name, this);
  }
}

function find(root: FakeElement, predicate: (value: FakeElement) => boolean): FakeElement {
  if (predicate(root)) return root;
  for (const child of root.children) {
    try {
      return find(child, predicate);
    } catch {}
  }
  throw new Error("not found");
}

function findAll(root: FakeElement, predicate: (value: FakeElement) => boolean): FakeElement[] {
  return [
    ...(predicate(root) ? [root] : []),
    ...root.children.flatMap((child) => findAll(child, predicate)),
  ];
}

function mountedView() {
  const document = new FakeDocument();
  const actionHost = document.createElement("nav");
  document.body.append(actionHost);
  const view = createReleaseNotesView({
    document: document as never,
    actionHost: actionHost as never,
  });
  return { document, actionHost, view };
}

describe("release notes view", () => {
  it("renders available and empty notes as literal text with only the fixed full-release link", () => {
    const { document, view } = mountedView();
    const hostile = `<img src=x onerror="steal()"> [click](javascript:steal())`;
    const releaseUrl =
      "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23";

    view.open();
    view.renderAvailable(available({ notes: [hostile], releaseUrl }));

    const dialog = find(document.body, (node) => node.tagName === "dialog");
    expect(dialog.open).toBe(true);
    expect(find(dialog, (node) => node.tagName === "h2").textContent).toBe(
      "What’s new in 2026.7.23",
    );
    const items = findAll(dialog, (node) => node.tagName === "li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe(hostile);
    expect(items[0]?.children).toHaveLength(0);
    const anchors = findAll(dialog, (node) => node.tagName === "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      textContent: "View full release",
      href: releaseUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      hidden: false,
    });

    view.renderAvailable(available({ notes: [] }));
    expect(dialog.textContent).toContain("No athlete-facing changes were listed for this release.");
    expect(findAll(dialog, (node) => node.tagName === "li")).toHaveLength(0);
  });

  it("shows fixed offline copy, exposes Retry, and never changes the draft or transcript", () => {
    const document = new FakeDocument();
    const transcript = document.createElement("section");
    transcript.className = "chat-transcript";
    transcript.textContent = "Existing coach transcript";
    const draft = document.createElement("textarea");
    draft.value = "Keep this draft";
    const actionHost = document.createElement("nav");
    document.body.append(transcript, draft, actionHost);
    const view = createReleaseNotesView({
      document: document as never,
      actionHost: actionHost as never,
    });
    const retryHandler = vi.fn();
    view.bind({ onOpen: vi.fn(), onRetry: retryHandler, onClose: vi.fn() });

    view.open();
    view.renderUnavailable({
      version: null,
      releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases",
    });
    const dialog = find(document.body, (node) => node.tagName === "dialog");
    expect(dialog.textContent).toContain(
      "Release notes aren’t available right now. Check your connection and try again.",
    );
    const retry = find(dialog, (node) => node.className === "release-notes__retry");
    expect(retry.hidden).toBe(false);
    retry.click();
    expect(retryHandler).toHaveBeenCalledOnce();
    expect(draft.value).toBe("Keep this draft");
    expect(transcript.textContent).toBe("Existing coach transcript");
  });

  it("supports the native cancel path, restores opener focus, and removes listeners on dispose", () => {
    const { document, actionHost, view } = mountedView();
    const opener = find(actionHost, (node) => node.className === "release-notes-button");
    const dialog = find(document.body, (node) => node.tagName === "dialog");
    view.bind({
      onOpen() {
        view.open();
        view.renderLoading();
      },
      onRetry: vi.fn(),
      onClose() {
        view.close();
      },
    });

    opener.click();
    expect(dialog.open).toBe(true);
    expect(opener.attributes.get("aria-expanded")).toBe("true");
    expect(document.activeElement?.className).toBe("release-notes__close");
    const preventDefault = vi.fn();
    dialog.dispatch("cancel", { preventDefault } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(opener.attributes.get("aria-expanded")).toBe("false");

    view.dispose();
    view.dispose();
    opener.click();
    expect(actionHost.children).not.toContain(opener);
    expect(document.body.children).not.toContain(dialog);
    expect(dialog.listeners.get("cancel")?.size).toBe(0);
    expect(opener.listeners.get("click")?.size).toBe(0);
  });
});
