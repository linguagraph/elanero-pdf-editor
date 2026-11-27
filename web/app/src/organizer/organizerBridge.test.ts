import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOrganizer,
  getOrganizerActions,
  getOrganizerStatus,
  type OrganizerActions,
  publishOrganizer,
  runOrganizerCommand,
  subscribeOrganizer,
  hasQueuedOrganizerCommands,
  takeQueuedOrganizerCommands,
} from './organizerBridge';

// Each action is a spy, so a test can see which one the bridge called.
function actionsStub() {
  return {
    rotate: vi.fn<(delta: number) => void>(),
    insertFile: vi.fn<() => void>(),
    duplicate: vi.fn<() => void>(),
    extract: vi.fn<() => void>(),
    askDelete: vi.fn<() => void>(),
    replace: vi.fn<() => void>(),
  } satisfies OrganizerActions;
}

beforeEach(() => {
  clearOrganizer();
  takeQueuedOrganizerCommands();
});

describe('organizer bridge publishing', () => {
  it('publishes the status and actions, and tells listeners once per change', () => {
    const listener = vi.fn();
    const stop = subscribeOrganizer(listener);
    const actions = actionsStub();

    publishOrganizer({ selected: 1, total: 3, busy: false }, actions);
    expect(getOrganizerStatus()).toEqual({ selected: 1, total: 3, busy: false });
    expect(getOrganizerActions()).toBe(actions);
    expect(listener).toHaveBeenCalledTimes(1);

    // The same status again changes nothing, so a panel that republishes each render cannot loop.
    publishOrganizer({ selected: 1, total: 3, busy: false }, actionsStub());
    expect(listener).toHaveBeenCalledTimes(1);

    publishOrganizer({ selected: 2, total: 3, busy: false }, actions);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('clears both on clearOrganizer and stops notifying the cleared listener', () => {
    const listener = vi.fn();
    subscribeOrganizer(listener);
    publishOrganizer({ selected: 1, total: 3, busy: true }, actionsStub());

    clearOrganizer();
    expect(getOrganizerStatus()).toBeNull();
    expect(getOrganizerActions()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    clearOrganizer();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('organizer bridge queued commands', () => {
  it('queues the command and opens the panel when no panel is publishing', () => {
    const open = vi.fn();
    runOrganizerCommand('rotate-pages-right', open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(takeQueuedOrganizerCommands()).toEqual(['rotate-pages-right']);
    // A queued command is taken once: a second take finds nothing to run.
    expect(takeQueuedOrganizerCommands()).toEqual([]);
  });

  it('runs the action directly, without opening or queueing, when the panel is publishing', () => {
    const open = vi.fn();
    const actions = actionsStub();
    publishOrganizer({ selected: 1, total: 3, busy: false }, actions);

    runOrganizerCommand('rotate-pages-right', open);
    expect(actions.rotate).toHaveBeenCalledWith(90);
    expect(open).not.toHaveBeenCalled();
    expect(takeQueuedOrganizerCommands()).toEqual([]);
  });

  it('clearing the panel drops a queued command that was never run', () => {
    runOrganizerCommand('delete-pages', () => {});
    clearOrganizer();
    expect(takeQueuedOrganizerCommands()).toEqual([]);
  });

  it('maps each ribbon command to the matching panel action', () => {
    const actions = actionsStub();
    publishOrganizer({ selected: 1, total: 3, busy: false }, actions);
    const open = vi.fn();

    runOrganizerCommand('rotate-pages-left', open);
    runOrganizerCommand('insert-pages', open);
    runOrganizerCommand('duplicate-pages', open);
    runOrganizerCommand('extract-pages', open);
    runOrganizerCommand('delete-pages', open);
    runOrganizerCommand('replace-pages', open);

    expect(actions.rotate).toHaveBeenCalledWith(270);
    expect(actions.insertFile).toHaveBeenCalledTimes(1);
    expect(actions.duplicate).toHaveBeenCalledTimes(1);
    expect(actions.extract).toHaveBeenCalledTimes(1);
    expect(actions.askDelete).toHaveBeenCalledTimes(1);
    expect(actions.replace).toHaveBeenCalledTimes(1);
  });

  it('a queued Replace opens the panel and its dialog, never a file chooser', () => {
    const open = vi.fn();
    runOrganizerCommand('replace-pages', open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(hasQueuedOrganizerCommands()).toBe(true);
    expect(takeQueuedOrganizerCommands()).toEqual(['replace-pages']);
  });
});
