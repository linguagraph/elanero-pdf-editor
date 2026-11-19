import { describe, expect, it, vi } from 'vitest';
import {
  hasFileHandling,
  installLaunchInbox,
  launchQueueOf,
  type LaunchFileHandleLike,
  type LaunchQueueLike,
  MAX_LAUNCH_FILES,
} from './launch';

// A fake launchQueue: `launch` plays the browser handing over a launch to the consumer.
function fakeQueue(): LaunchQueueLike & {
  launch(files: readonly LaunchFileHandleLike[]): void;
  setConsumer: ReturnType<typeof vi.fn>;
} {
  let consumer: ((params: { files: readonly LaunchFileHandleLike[] }) => void) | null = null;
  const setConsumer = vi.fn(
    (next: (params: { files: readonly LaunchFileHandleLike[] }) => void) => {
      consumer = next;
    },
  );
  return {
    setConsumer,
    launch(files) {
      if (consumer === null) throw new Error('no consumer set');
      consumer({ files });
    },
  };
}

function handle(
  name: string,
  file?: File | Error,
): LaunchFileHandleLike & {
  getFile: ReturnType<typeof vi.fn>;
} {
  const getFile = vi.fn(async () => {
    if (file instanceof Error) throw file;
    return file ?? new File(['%PDF-1.4'], name, { type: 'application/pdf' });
  });
  return { kind: 'file', name, getFile };
}

const report = () => ({ failed: vi.fn(), tooMany: vi.fn() });

// Lets the queued promise chain (getFile, allSettled) run to its end.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('launch queue detection', () => {
  it('finds no queue on a window without launchQueue, and one with it', () => {
    expect(hasFileHandling({} as Window)).toBe(false);
    expect(launchQueueOf({} as Window)).toBeUndefined();
    const queue = fakeQueue();
    const win = { launchQueue: queue } as unknown as Window;
    expect(hasFileHandling(win)).toBe(true);
    expect(launchQueueOf(win)).toBe(queue);
  });

  it('treats a null launchQueue as absent', () => {
    expect(hasFileHandling({ launchQueue: null } as unknown as Window)).toBe(false);
  });
});

describe('installLaunchInbox', () => {
  it('without a queue never delivers and sets no consumer', async () => {
    const inbox = installLaunchInbox(undefined, report());
    const sink = vi.fn();
    inbox.attach(sink);
    await settle();
    expect(sink).not.toHaveBeenCalled();
  });

  it('sets the consumer exactly once', () => {
    const queue = fakeQueue();
    installLaunchInbox(queue, report());
    expect(queue.setConsumer).toHaveBeenCalledTimes(1);
  });

  it('buffers a launch that arrives before attach, and delivers it on attach, in order', async () => {
    const queue = fakeQueue();
    const inbox = installLaunchInbox(queue, report());
    queue.launch([handle('a.pdf')]);
    queue.launch([handle('b.pdf')]);
    await settle();
    const sink = vi.fn();
    inbox.attach(sink);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.map((call) => (call[0] as File[])[0]?.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('delivers a buffered launch once only: detach and re-attach do not repeat it', async () => {
    const queue = fakeQueue();
    const inbox = installLaunchInbox(queue, report());
    queue.launch([handle('a.pdf')]);
    await settle();
    const first = vi.fn();
    const detach = inbox.attach(first);
    detach();
    const second = vi.fn();
    inbox.attach(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('sends a launch after attach straight to the sink', async () => {
    const queue = fakeQueue();
    const inbox = installLaunchInbox(queue, report());
    const sink = vi.fn();
    inbox.attach(sink);
    queue.launch([handle('late.pdf')]);
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
    expect((sink.mock.calls[0]?.[0] as File[])[0]?.name).toBe('late.pdf');
  });

  it('holds a launch made while detached until the next attach', async () => {
    const queue = fakeQueue();
    const inbox = installLaunchInbox(queue, report());
    const detach = inbox.attach(vi.fn());
    detach();
    queue.launch([handle('gap.pdf')]);
    await settle();
    const sink = vi.fn();
    inbox.attach(sink);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty launch (a plain app start) and a directory handle', async () => {
    const queue = fakeQueue();
    const inbox = installLaunchInbox(queue, report());
    const sink = vi.fn();
    inbox.attach(sink);
    queue.launch([]);
    const directory = { kind: 'directory', name: 'folder', getFile: vi.fn() };
    queue.launch([directory]);
    await settle();
    expect(sink).not.toHaveBeenCalled();
    expect(directory.getFile).not.toHaveBeenCalled();
  });

  it('reports a file that cannot be read and still delivers the others, in order', async () => {
    const queue = fakeQueue();
    const issues = report();
    const inbox = installLaunchInbox(queue, issues);
    const sink = vi.fn();
    inbox.attach(sink);
    queue.launch([handle('one.pdf'), handle('gone.pdf', new Error('moved')), handle('two.pdf')]);
    await settle();
    expect(issues.failed).toHaveBeenCalledWith('gone.pdf');
    expect(sink).toHaveBeenCalledTimes(1);
    expect((sink.mock.calls[0]?.[0] as File[]).map((file) => file.name)).toEqual([
      'one.pdf',
      'two.pdf',
    ]);
  });

  it('takes at most MAX_LAUNCH_FILES files and does not ask for the rest', async () => {
    const queue = fakeQueue();
    const issues = report();
    const inbox = installLaunchInbox(queue, issues);
    const sink = vi.fn();
    inbox.attach(sink);
    const handles = Array.from({ length: 25 }, (_, index) => handle(`f${index}.pdf`));
    queue.launch(handles);
    await settle();
    expect(MAX_LAUNCH_FILES).toBe(20);
    expect(issues.tooMany).toHaveBeenCalledWith(20);
    expect((sink.mock.calls[0]?.[0] as File[]).length).toBe(20);
    expect(handles.slice(0, 20).every((h) => h.getFile.mock.calls.length === 1)).toBe(true);
    expect(handles.slice(20).some((h) => h.getFile.mock.calls.length > 0)).toBe(false);
  });

  it('does not read the bytes of a file (File.arrayBuffer is never called)', async () => {
    const queue = fakeQueue();
    const inbox = installLaunchInbox(queue, report());
    const sink = vi.fn();
    inbox.attach(sink);
    const file = new File(['%PDF-1.4'], 'bytes.pdf', { type: 'application/pdf' });
    const read = vi.spyOn(file, 'arrayBuffer').mockImplementation(() => {
      throw new Error('must not read');
    });
    queue.launch([handle('bytes.pdf', file)]);
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledWith([file]);
  });
});
