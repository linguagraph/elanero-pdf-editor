// The File Handling API (W4.6 S1): a PDF the user opens with Elanero from the OS (Explorer, Finder,
// the dock) reaches the page through `window.launchQueue`. This module turns that launch into plain
// File references and hands them to the same sink as the Open button and drag and drop, so a
// launched file gets the same checks and queue (the PDF check, the size refusal, "Waiting to open",
// the password prompt). It never reads bytes and keeps no handle: `getFile()` only returns a File.
// Where the API is absent (other browsers, a plain tab) nothing is delivered and nothing changes.

export interface LaunchFileHandleLike {
  readonly kind: string;
  readonly name: string;
  getFile(): Promise<File>;
}

export interface LaunchParamsLike {
  readonly files: readonly LaunchFileHandleLike[];
}

export interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

// A launch with more files than this opens only the first ones: each file is a tab, and each
// password-protected file asks for its password, so a huge launch would flood the user.
export const MAX_LAUNCH_FILES = 20;

export interface LaunchReport {
  // getFile() rejected: the file was moved, deleted, or its permission was refused.
  failed(name: string): void;
  // The launch had more than MAX_LAUNCH_FILES files; only the first `max` are opened.
  tooMany(max: number): void;
}

export interface LaunchInbox {
  // Delivers the launches buffered so far at once, then each later launch, to `open`. Returns the
  // detach function. A buffered launch goes to the first sink only: a detach and a re-attach
  // (StrictMode runs effects twice) never deliver it again.
  attach(open: (files: readonly File[]) => void): () => void;
}

type Sink = (files: readonly File[]) => void;

// The queue on a window, or undefined when the browser has no File Handling API.
export function launchQueueOf(win: Window): LaunchQueueLike | undefined {
  if (!('launchQueue' in win)) return undefined;
  const queue = (win as Window & { launchQueue?: LaunchQueueLike }).launchQueue;
  return queue === undefined || queue === null ? undefined : queue;
}

// The browser fact: true when this window can receive files handed to the app by the OS.
export function hasFileHandling(win: Window): boolean {
  return launchQueueOf(win) !== undefined;
}

// Sets the queue's consumer once. Without a queue the inbox never delivers anything.
// `remember` gets each launched file's handle, so Open recent can reopen it (issue 756).
export function installLaunchInbox(
  queue: LaunchQueueLike | undefined,
  report: LaunchReport,
  remember?: (handle: LaunchFileHandleLike) => void,
): LaunchInbox {
  let sink: Sink | null = null;
  // Launches that arrived before a sink was attached, in arrival order, as File references only.
  let buffered: (readonly File[])[] = [];

  function deliver(files: readonly File[]): void {
    if (sink === null) {
      buffered = [...buffered, files];
    } else {
      sink(files);
    }
  }

  async function collect(params: LaunchParamsLike): Promise<void> {
    // A plain app start (no files) and directories are not for us.
    const handles = params.files.filter((handle) => handle.kind === 'file');
    if (handles.length === 0) return;
    if (handles.length > MAX_LAUNCH_FILES) report.tooMany(MAX_LAUNCH_FILES);
    const taken = handles.slice(0, MAX_LAUNCH_FILES);
    // The calls to getFile() happen in launch order; the results keep that order.
    const settled = await Promise.allSettled(
      taken.map((handle) => new Promise<File>((resolve) => resolve(handle.getFile()))),
    );
    const files: File[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        files.push(result.value);
        const handle = taken[index];
        if (handle !== undefined) remember?.(handle);
      } else {
        report.failed(taken[index]?.name ?? '');
      }
    });
    if (files.length > 0) deliver(files);
  }

  if (queue !== undefined) {
    queue.setConsumer((params) => {
      void collect(params);
    });
  }

  return {
    attach(open: Sink): () => void {
      sink = open;
      const pending = buffered;
      buffered = [];
      for (const files of pending) open(files);
      return () => {
        if (sink === open) sink = null;
      };
    },
  };
}
