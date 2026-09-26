import {
  PanelIntent,
  QUICK_ACTIONS,
  type Activity,
  type DeviceBus,
  type DeviceEvent,
  type PanelClient,
  type PanelLinking,
  type PanelViewModel,
  type RoomModel,
  type RoomStatus,
  type TriggerTarget,
} from '@kestrel/model';
import { executePlan } from '../plan/execute';
import { activitySources, planActivity, planState, planStopOverlay, type Plan } from '../plan/plan';
import { buildGraph, deviceCapabilities, type Graph } from '../validate/graph';
import { availableActivities, detectorsFor, type SignalDetector } from './activities';
import { functionSets, functionsView, type FunctionSets } from './functions';
import {
  quickActionActive,
  quickActionCommand,
  roomQuickActions,
  type RoomQuickAction,
} from './quick-actions';

export interface RuntimeOptions {
  model: RoomModel;
  roomName: string;
  bus: DeviceBus;
  /** Per-step limit passed to the executor. */
  stepTimeoutMs?: number;
  /** The panel asked to open or close a movable wall (Room linking menu). */
  onDivider?: (dividerId: string, open: boolean) => void;
}

/** What a room was doing when it was suspended, so it can be brought back. */
export interface ParkedState {
  /** The room was on (or starting). */
  on: boolean;
  primary: { activityId: string; sourceId?: string } | null;
  /** Overlay activities that were running, such as Record. */
  overlays: string[];
}

interface Primary {
  activityId: string;
  sourceId?: string;
  sourceDeviceId?: string;
}

interface Prompt {
  id: string;
  activityId: string;
  sourceId: string;
  deadline: number | null;
}

const OFF_ACTIVITY: Activity = {
  id: '__room_off',
  name: 'Room Off',
  kind: 'room_off',
  hidden: false,
  requires: [],
  sources: [],
  actions: [],
};

/**
 * One room's live behaviour. It owns the room's state, turns panel intents into device commands via
 * the planner, watches device feedback (signal detect), and runs the walk-in behaviours: auto-start
 * on signal, the second-source prompt, idle warning and auto-off. No IO of its own: everything goes
 * through the DeviceBus, so the same code runs on the gateway and in the browser simulator.
 */
export class RoomRuntime implements PanelClient {
  private readonly model: RoomModel;
  private readonly bus: DeviceBus;
  private readonly graph: Graph;
  private readonly detectors: Map<string, SignalDetector | null>;
  private readonly activities: Activity[];
  private readonly volumeDevices: string[];
  private readonly quickActions: RoomQuickAction[];
  private readonly functions: FunctionSets;
  /** A moving camera stops by itself if the panel stops asking, so a dropped connection never leaves it running. */
  private readonly cameraStops = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly stepTimeoutMs?: number;

  private status: RoomStatus = 'off';
  private primary: Primary | null = null;
  private overlays = new Set<string>();
  private starting: string | null = null;
  private faultDevice: string | null = null;
  private faultText: string | null = null;
  private volume: number;
  /** Set once any device has reported its own level. Until then the number is only our guess. */
  private volumeFeedback = false;
  private muted = false;
  private prompt: Prompt | null = null;
  private warningDeadline: number | null = null;
  private savedUntil = 0;
  private lastPresence = new Map<string, boolean | null>();
  private lastOccupied = new Map<string, boolean | undefined>();

  private runId = 0;
  private abort: AbortController | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private warningTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private volumeInFlight = false;
  private volumeQueued: number | null = null;
  private snapshot: PanelViewModel;
  private disposed = false;
  /** While a combined room that includes this one is live, this room must not touch the devices. */
  private suspended = false;
  private linking: PanelLinking | null = null;

  constructor(private readonly opts: RuntimeOptions) {
    this.model = opts.model;
    this.bus = opts.bus;
    this.stepTimeoutMs = opts.stepTimeoutMs;
    this.graph = buildGraph(this.model);
    this.detectors = detectorsFor(this.model);
    this.activities = availableActivities(this.model);
    this.volumeDevices = this.model.devices
      .filter((d) => deviceCapabilities(d).has('volume'))
      .map((d) => d.id);
    this.quickActions = roomQuickActions(this.model, this.bus);
    this.functions = functionSets(this.model);
    this.volume = this.model.settings.defaultVolume;
    this.adoptDeviceState();
    for (const [source] of this.detectors) this.lastPresence.set(source, this.presence(source));
    this.snapshot = this.buildSnapshot();
    this.unsubscribe = this.bus.subscribe((e) => this.onDeviceEvent(e));
    // Panels pass these around as callbacks; keep `this` attached.
    this.getSnapshot = this.getSnapshot.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.dispatch = this.dispatch.bind(this);
  }

  // ---- PanelClient ----------------------------------------------------------------------------

  getSnapshot(): PanelViewModel {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(raw: PanelIntent): void {
    const parsed = PanelIntent.safeParse(raw);
    if (!parsed.success || this.disposed || this.suspended) return;
    const intent = parsed.data;
    // Any touch counts as someone being here: cancel a pending auto-off.
    if (intent.type !== 'warning.dismiss') this.userPresent();
    switch (intent.type) {
      case 'activity.start':
        return void this.startActivity(intent.activityId, intent.sourceId);
      case 'activity.stop':
        return void this.stopOverlay(intent.activityId);
      case 'volume.set':
        return this.setVolume(intent.level);
      case 'volume.bump':
        return this.setVolume(this.volume + intent.delta);
      case 'mute.set':
        return void this.setMuted(intent.muted);
      case 'prompt.respond':
        return this.respondToPrompt(intent.promptId, intent.accept);
      case 'warning.dismiss':
        return this.dismissWarning();
      case 'quickaction.run':
        return void this.runQuickAction(intent.id, intent.active);
      case 'room.on': {
        const on = this.model.states.find((s) => s.kind === 'on');
        if (on && this.status === 'off') void this.runState(on.id);
        return;
      }
      case 'divider.set':
        this.opts.onDivider?.(intent.dividerId, intent.open);
        return;
      case 'camera.preset': {
        const cam = this.functions.cameras.find((c) => c.device.id === intent.deviceId);
        if (cam?.presets.includes(intent.preset))
          this.tell(cam.device.id, { type: 'camera_preset', name: intent.preset });
        return;
      }
      case 'camera.move':
        return this.moveCamera(intent.deviceId, intent.pan, intent.tilt, intent.zoom);
      case 'mic.mute':
        if (this.functions.microphones.some((d) => d.id === intent.deviceId))
          this.tell(intent.deviceId, { type: 'mute', muted: intent.muted });
        return;
      case 'scene.set': {
        const light = this.functions.lights.find((l) => l.device.id === intent.deviceId);
        if (light?.scenes.includes(intent.scene))
          this.tell(light.device.id, { type: 'scene', name: intent.scene });
        return;
      }
      case 'mover.run': {
        const mover = this.functions.movers.find((m) => m.device.id === intent.deviceId);
        if (mover?.actions.includes(intent.action))
          this.tell(mover.device.id, { type: 'command', name: intent.action, args: {} });
        return;
      }
    }
  }

  /** Send one command to a device and refresh the panel; a device that refuses just does not change. */
  private tell(deviceId: string, command: Parameters<DeviceBus['send']>[1]) {
    void this.bus
      .send(deviceId, command)
      .catch(() => undefined)
      .finally(() => this.notify());
  }

  private moveCamera(deviceId: string, pan: number, tilt: number, zoom: number) {
    if (!this.functions.cameras.some((c) => c.device.id === deviceId)) return;
    const running = this.cameraStops.get(deviceId);
    if (running) clearTimeout(running);
    this.cameraStops.delete(deviceId);
    this.tell(deviceId, { type: 'camera_move', pan, tilt, zoom });
    if (pan === 0 && tilt === 0 && zoom === 0) return;
    // Held buttons repeat every half second; if they stop, so does the camera.
    const stop = setTimeout(() => {
      this.cameraStops.delete(deviceId);
      this.tell(deviceId, { type: 'camera_move', pan: 0, tilt: 0, zoom: 0 });
    }, 2000);
    stop.unref?.();
    this.cameraStops.set(deviceId, stop);
  }

  private stopCameras() {
    for (const [deviceId, timer] of this.cameraStops) {
      clearTimeout(timer);
      this.tell(deviceId, { type: 'camera_move', pan: 0, tilt: 0, zoom: 0 });
    }
    this.cameraStops.clear();
  }

  dispose() {
    this.stopCameras();
    this.disposed = true;
    this.abort?.abort();
    this.unsubscribe();
    this.clearIdle();
    this.clearPrompt();
    this.clearWarning();
    this.stopTicker();
    this.listeners.clear();
  }

  // ---- Room groups ----------------------------------------------------------------------------

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** The walls and joined rooms the Room linking menu shows. null: not in a room group. */
  setLinking(info: PanelLinking | null) {
    if (JSON.stringify(info) === JSON.stringify(this.linking)) return;
    this.linking = info;
    this.notify();
  }

  /**
   * Stop acting on the devices, because another room's program is running them (a combined room
   * that includes this one). Anything in flight is abandoned and timers are cleared. Returns what
   * the room was doing, to restore later.
   */
  suspend(): ParkedState {
    const parked: ParkedState = {
      on: this.status === 'on' || this.status === 'starting',
      primary: this.primary
        ? { activityId: this.primary.activityId, sourceId: this.primary.sourceId }
        : null,
      overlays: [...this.overlays],
    };
    if (this.suspended || this.disposed) return parked;
    this.suspended = true;
    this.abort?.abort();
    this.runId++;
    this.clearIdle();
    this.clearPrompt();
    this.clearWarning();
    this.stopTicker();
    this.stopCameras();
    this.notify();
    return parked;
  }

  /**
   * Take the devices back. What the room believed about itself is dropped, because someone else has
   * been driving the devices: it starts from off, and the caller says what to do next
   * (turnOff, turnOn or restore).
   */
  resume() {
    if (!this.suspended || this.disposed) return;
    this.suspended = false;
    this.primary = null;
    this.overlays.clear();
    this.starting = null;
    this.faultDevice = null;
    this.faultText = null;
    this.status = 'off';
    this.adoptDeviceState();
    this.notify();
  }

  /** Run the On state (devices on, nothing chosen yet). */
  turnOn(): Promise<void> {
    const on = this.model.states.find((s) => s.kind === 'on');
    if (!on || this.suspended || this.disposed) return Promise.resolve();
    return this.runState(on.id);
  }

  /** Run Room Off even if the room thinks it is already off: the devices may not agree. */
  turnOff(): Promise<void> {
    if (this.suspended || this.disposed) return Promise.resolve();
    return this.roomOff();
  }

  /** Bring back what a room was doing. A room that was off (or never ran) is turned off. */
  async restore(state: ParkedState | undefined): Promise<void> {
    if (!state || !state.on) return this.turnOff();
    if (state.primary) {
      await this.startActivity(state.primary.activityId, state.primary.sourceId);
      for (const id of state.overlays) await this.startActivity(id);
      return;
    }
    await this.turnOn();
    for (const id of state.overlays) await this.startActivity(id);
  }

  // ---- Triggers -------------------------------------------------------------------------------

  /** Run what a trigger points at: an activity (with a source) or a state. Used by schedules, hooks and sensors. */
  fire(target: TriggerTarget): void {
    if (this.disposed || this.suspended) return;
    if (target.type === 'activity')
      return void this.startActivity(target.activityId, target.sourceId);
    void this.runState(target.stateId);
  }

  /** Run one enabled trigger by id, whatever its kind (a calendar meeting starting, say). Returns whether it ran. */
  fireTrigger(triggerId: string): boolean {
    if (this.suspended) return false;
    const t = this.model.triggers.find((x) => x.id === triggerId && x.enabled);
    if (!t) return false;
    this.fire(t.run);
    return true;
  }

  /** An external call (webhook) by name. Returns how many triggers ran. */
  fireHook(hookName: string): number {
    if (this.suspended) return 0;
    const hooks = this.model.triggers.filter(
      (t) => t.type === 'webhook' && t.enabled && t.hookName === hookName,
    );
    for (const t of hooks) this.fire(t.run);
    return hooks.length;
  }

  private async runState(stateId: string) {
    const state = this.model.states.find((s) => s.id === stateId);
    if (!state) return;
    if (state.kind === 'off') return this.roomOff();
    const { run, signal } = this.begin(state.kind === 'on' ? 'starting' : this.status);
    this.notify();
    const ok = await this.run(planState(this.model, stateId), run, signal);
    if (!ok) return;
    if (state.kind === 'on') this.status = 'on';
    else if (this.status === 'starting') this.status = this.primary ? 'on' : 'off';
    this.adoptDeviceState();
    this.evaluateIdle();
    this.notify();
  }

  private occupancyChanged(event: DeviceEvent) {
    const before = this.lastOccupied.get(event.deviceId);
    const now = event.state.occupied;
    this.lastOccupied.set(event.deviceId, now);
    if (now === undefined || before === now) return;
    for (const t of this.model.triggers)
      if (
        t.type === 'occupancy' &&
        t.enabled &&
        t.deviceId === event.deviceId &&
        t.occupied === now
      )
        this.fire(t.run);
  }

  // ---- Activities -----------------------------------------------------------------------------

  private async startActivity(activityId: string, sourceId?: string) {
    const activity = this.activities.find((a) => a.id === activityId);
    if (!activity) return;
    if (activity.kind === 'room_off') return this.roomOff();
    if (activity.kind === 'record') return this.startOverlay(activity);
    return this.startPrimary(activity, sourceId);
  }

  private begin(status: RoomStatus): { run: number; signal: AbortSignal } {
    this.abort?.abort();
    this.abort = new AbortController();
    this.runId++;
    this.status = status;
    this.faultDevice = null;
    this.faultText = null;
    this.clearPrompt();
    this.clearWarning();
    this.clearIdle();
    return { run: this.runId, signal: this.abort.signal };
  }

  private async run(plan: Plan, run: number, signal: AbortSignal) {
    if (plan.problems.length) {
      this.fault(null, plan.problems[0]!.message);
      return null;
    }
    const result = await executePlan(plan, this.bus, { signal, timeoutMs: this.stepTimeoutMs });
    if (run !== this.runId || this.disposed) return null; // superseded by a newer request
    if (!result.ok) {
      const failed = result.results.find((r) => r.status === 'failed');
      const step = plan.steps.find((s) => s.id === failed?.stepId);
      this.fault(
        step ? (this.graph.devices.get(step.deviceId)?.name ?? step.deviceId) : null,
        failed?.error,
      );
      return null;
    }
    return result;
  }

  private async startPrimary(activity: Activity, sourceId?: string) {
    const sources = activitySources(this.model, activity);
    const source = sources.find((s) => s.id === sourceId) ?? sources[0];
    const { run, signal } = this.begin('starting');
    this.starting = activity.id;
    this.notify();
    const plan = planActivity(this.model, activity, { sourceId: source?.id });
    const ok = await this.run(plan, run, signal);
    if (!ok) return;
    this.starting = null;
    this.status = 'on';
    this.primary = {
      activityId: activity.id,
      sourceId: source?.id,
      sourceDeviceId: plan.sourceDeviceId,
    };
    this.adoptDeviceState();
    this.evaluateIdle();
    this.notify();
  }

  private async startOverlay(activity: Activity) {
    const wasOff = this.status === 'off';
    this.starting = activity.id;
    this.notify();
    const plan = planActivity(this.model, activity, {
      currentSourceDeviceId: this.primary?.sourceDeviceId,
    });
    const runId = this.runId;
    const signal = this.abort?.signal ?? new AbortController().signal;
    const result = await this.run(plan, runId, signal);
    this.starting = null;
    if (!result) return this.notify();
    this.overlays.add(activity.id);
    if (wasOff) this.status = 'on';
    this.notify();
  }

  private async stopOverlay(activityId: string) {
    const activity = this.activities.find((a) => a.id === activityId);
    if (!activity || !this.overlays.has(activityId)) return;
    const plan = planStopOverlay(this.model, activity);
    const result = await executePlan(plan, this.bus, { timeoutMs: this.stepTimeoutMs });
    if (!result.ok) {
      const failed = result.results.find((r) => r.status === 'failed');
      const device = plan.steps.find((s) => s.id === failed?.stepId)?.deviceId;
      return this.fault(
        device ? (this.graph.devices.get(device)?.name ?? device) : null,
        failed?.error,
      );
    }
    this.overlays.delete(activityId);
    this.savedUntil = Date.now() + 4000;
    if (!this.primary && this.overlays.size === 0) this.status = 'off';
    this.notify();
    setTimeout(() => !this.disposed && this.notify(), 4100);
  }

  private async roomOff() {
    const { run, signal } = this.begin('stopping');
    this.starting = null;
    this.notify();
    const activity = this.model.activities.find((a) => a.kind === 'room_off');
    const off: Activity = activity ?? {
      ...OFF_ACTIVITY,
      actions: this.model.states
        .filter((s) => s.kind === 'off')
        .slice(0, 1)
        .map((s) => ({ id: 'a1', type: 'run_state' as const, stateId: s.id, dependsOn: [] })),
    };
    const plan = planActivity(this.model, off);
    // Also stop anything still recording.
    for (const id of this.overlays) {
      const overlay = this.activities.find((a) => a.id === id);
      if (overlay)
        plan.steps.push(
          ...planStopOverlay(this.model, overlay).steps.map((s, i) => ({
            ...s,
            id: `stop${i}-${s.id}`,
          })),
        );
    }
    const hadRecording = this.overlays.size > 0;
    const ok = await this.run(plan, run, signal);
    if (!ok) return;
    this.primary = null;
    this.overlays.clear();
    this.status = 'off';
    if (hadRecording) this.savedUntil = Date.now() + 4000;
    this.adoptDeviceState();
    this.notify();
  }

  private fault(device: string | null, detail?: string) {
    this.status = 'fault';
    this.starting = null;
    this.faultDevice = device;
    this.faultText = detail ?? null;
    this.notify();
  }

  // ---- Volume ---------------------------------------------------------------------------------

  private setVolume(level: number) {
    if (this.volumeDevices.length === 0) return;
    this.volume = Math.min(100, Math.max(0, Math.round(level)));
    this.muted = false;
    this.notify();
    // Coalesce rapid changes (press-and-hold ramps): one command in flight, latest value wins.
    if (this.volumeInFlight) {
      this.volumeQueued = this.volume;
      return;
    }
    void this.flushVolume();
  }

  private async flushVolume() {
    this.volumeInFlight = true;
    let next: number | null = this.volume;
    while (next !== null && !this.disposed) {
      const level = next;
      this.volumeQueued = null;
      await Promise.allSettled(
        this.volumeDevices.flatMap((id) => [
          this.bus.send(id, { type: 'volume', level }),
          this.bus.send(id, { type: 'mute', muted: false }),
        ]),
      );
      next = this.volumeQueued;
    }
    this.volumeInFlight = false;
  }

  private async setMuted(muted: boolean) {
    if (this.volumeDevices.length === 0) return;
    this.muted = muted;
    this.notify();
    await Promise.allSettled(
      this.volumeDevices.map((id) => this.bus.send(id, { type: 'mute', muted })),
    );
  }

  // ---- Quick actions --------------------------------------------------------------------------

  /** One button acts on every device that supports it. State comes back through device feedback. */
  private async runQuickAction(id: string, active?: boolean) {
    const action = this.quickActions.find((a) => a.id === id);
    if (!action) return;
    const on = active ?? !quickActionActive(action, (d) => this.bus.getState(d));
    await Promise.allSettled(
      action.devices.map((d) => this.bus.send(d, quickActionCommand(action.id, on))),
    );
    this.notify();
  }

  // ---- Feedback, walk-in behaviour ------------------------------------------------------------

  private presence(sourceDeviceId: string): boolean | null {
    const detector = this.detectors.get(sourceDeviceId);
    if (!detector) return null;
    const state = this.bus.getState(detector.deviceId);
    if (!state || !state.online) return null;
    return state.signal[detector.portId] ?? null;
  }

  private adoptDeviceState() {
    for (const id of this.volumeDevices) {
      const s = this.bus.getState(id);
      if (s?.volume !== undefined) {
        this.volume = s.volume;
        this.volumeFeedback = true;
      }
      if (s?.muted !== undefined) this.muted = s.muted;
    }
    if (this.status === 'off' && !this.primary) {
      const anyOn = this.model.devices.some((d) => {
        const p = this.bus.getState(d.id)?.power;
        return d.category === 'video_destination' && (p === 'on' || p === 'warming');
      });
      if (anyOn) this.status = 'on';
    }
  }

  private onDeviceEvent(event: DeviceEvent) {
    if (this.disposed || this.suspended) return;
    if (this.volumeDevices.includes(event.deviceId) && !this.volumeInFlight) {
      if (event.state.volume !== undefined) {
        this.volume = event.state.volume;
        this.volumeFeedback = true;
      }
      if (event.state.muted !== undefined) this.muted = event.state.muted;
    }
    this.occupancyChanged(event);
    for (const [source, detector] of this.detectors) {
      if (detector?.deviceId !== event.deviceId) continue;
      const now = this.presence(source);
      const before = this.lastPresence.get(source) ?? null;
      this.lastPresence.set(source, now);
      if (now === true && before !== true) this.signalAppeared(source);
      if (now === false && before === true) this.signalLost(source);
    }
    this.notify();
  }

  private signalAppeared(sourceDeviceId: string) {
    this.evaluateIdle();
    const trigger = this.model.triggers.find(
      (t) => t.type === 'signal_detect' && t.enabled && t.deviceId === sourceDeviceId,
    );
    if (!trigger || trigger.run.type !== 'activity') return;
    const activity = this.activities.find(
      (a) => a.id === (trigger.run as { activityId: string }).activityId,
    );
    if (!activity) return;
    const sourceId =
      trigger.run.sourceId ?? activity.sources.find((s) => s.deviceId === sourceDeviceId)?.id;
    if (this.starting) return;
    const current = this.primary;
    if (this.status !== 'on' || !current) return void this.startActivity(activity.id, sourceId);
    if (current.sourceId === sourceId) return;
    // Someone plugged in a second source while one is showing: ask, and switch on their behalf.
    const seconds = this.model.settings.sourceConflictSeconds;
    if (seconds === 0) return void this.startActivity(activity.id, sourceId);
    this.clearPrompt();
    this.prompt = {
      id: `switch-${sourceId}-${Date.now()}`,
      activityId: activity.id,
      sourceId: sourceId ?? '',
      deadline: Date.now() + seconds * 1000,
    };
    this.promptTimer = setTimeout(
      () => this.respondToPrompt(this.prompt?.id ?? '', true),
      seconds * 1000,
    );
    this.startTicker();
  }

  private signalLost(sourceDeviceId: string) {
    if (
      this.prompt &&
      this.sourceDevice(this.prompt.activityId, this.prompt.sourceId) === sourceDeviceId
    )
      this.clearPrompt();
    this.evaluateIdle();
  }

  private sourceDevice(activityId: string, sourceId: string): string | undefined {
    return this.activities.find((a) => a.id === activityId)?.sources.find((s) => s.id === sourceId)
      ?.deviceId;
  }

  private respondToPrompt(promptId: string, accept: boolean) {
    const prompt = this.prompt;
    if (!prompt || prompt.id !== promptId) return;
    this.clearPrompt();
    if (accept) void this.startActivity(prompt.activityId, prompt.sourceId);
    this.notify();
  }

  // ---- Idle / auto-off ------------------------------------------------------------------------

  /** Auto-off only runs when the room can tell whether anyone is still using it. */
  private canDetectIdle(): boolean {
    const a = this.primary && this.activities.find((x) => x.id === this.primary!.activityId);
    if (!a || a.kind !== 'present') return false;
    return a.sources.length > 0 && a.sources.every((s) => this.presence(s.deviceId) !== null);
  }

  private anySignal(): boolean {
    const a = this.primary && this.activities.find((x) => x.id === this.primary!.activityId);
    return !!a && a.sources.some((s) => this.presence(s.deviceId) === true);
  }

  private evaluateIdle() {
    const { enabled, idleSeconds } = this.model.settings.autoOff;
    const idle = enabled && this.status === 'on' && this.canDetectIdle() && !this.anySignal();
    if (!idle) {
      this.clearIdle();
      this.clearWarning();
      return;
    }
    if (this.idleTimer || this.warningTimer) return;
    this.idleTimer = setTimeout(() => this.startWarning(), idleSeconds * 1000);
  }

  private startWarning() {
    this.idleTimer = null;
    const { warnSeconds } = this.model.settings.autoOff;
    if (warnSeconds === 0) return void this.roomOff();
    this.warningDeadline = Date.now() + warnSeconds * 1000;
    this.warningTimer = setTimeout(() => {
      this.warningTimer = null;
      this.warningDeadline = null;
      void this.roomOff();
    }, warnSeconds * 1000);
    this.startTicker();
    this.notify();
  }

  private dismissWarning() {
    this.clearWarning();
    this.evaluateIdle();
    this.notify();
  }

  private userPresent() {
    if (this.warningTimer || this.idleTimer) {
      this.clearIdle();
      this.clearWarning();
      this.evaluateIdle();
    }
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearWarning() {
    if (this.warningTimer) clearTimeout(this.warningTimer);
    this.warningTimer = null;
    this.warningDeadline = null;
    if (!this.prompt) this.stopTicker();
  }

  private clearPrompt() {
    if (this.promptTimer) clearTimeout(this.promptTimer);
    this.promptTimer = null;
    this.prompt = null;
    if (!this.warningTimer) this.stopTicker();
  }

  private startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.notify(), 1000);
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  // ---- View model -----------------------------------------------------------------------------

  private notify() {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }

  private secondsLeft(deadline: number | null): number | null {
    return deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  }

  private buildSnapshot(): PanelViewModel {
    const primaryActivity =
      this.primary && this.activities.find((a) => a.id === this.primary!.activityId);
    const activities = this.activities.map((a) => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      kind: a.kind,
      overlay: a.kind === 'record',
      busy: this.starting === a.id || (a.kind === 'room_off' && this.status === 'stopping'),
      active:
        a.kind === 'room_off'
          ? this.status === 'off'
          : this.primary?.activityId === a.id || this.overlays.has(a.id),
      sources: activitySources(this.model, a)
        .filter(() => a.kind === 'present' || a.kind === 'video_call')
        .map((s) => ({
          id: s.id,
          label: s.label,
          present: this.presence(s.device.id),
          selected: this.primary?.activityId === a.id && this.primary.sourceId === s.id,
        })),
    }));

    const source = primaryActivity
      ? activitySources(this.model, primaryActivity).find((s) => s.id === this.primary!.sourceId)
      : undefined;
    let message: PanelViewModel['message'];
    const recording = [...this.overlays].some(
      (id) => this.activities.find((a) => a.id === id)?.kind === 'record',
    );
    if (this.status === 'starting')
      message = { text: { key: 'starting', params: {} }, tone: 'progress' };
    else if (this.status === 'stopping')
      message = { text: { key: 'stopping', params: {} }, tone: 'progress' };
    else if (this.status === 'fault')
      message = {
        text: this.faultDevice
          ? { key: 'fault_device', params: { device: this.faultDevice } }
          : { key: 'fault_generic', params: {} },
        tone: 'error',
      };
    else if (recording) message = { text: { key: 'recording', params: {} }, tone: 'success' };
    else if (Date.now() < this.savedUntil)
      message = { text: { key: 'recording_saved', params: {} }, tone: 'success' };
    else if (this.status === 'on' && source && this.presence(source.device.id) === false)
      message = { text: { key: 'plug_in_source', params: { source: source.label } }, tone: 'warn' };
    else if (this.status === 'on' && source)
      message = { text: { key: 'presenting', params: { source: source.label } }, tone: 'success' };
    else if (this.status === 'on')
      message = { text: { key: 'ready', params: {} }, tone: 'success' };
    else message = { text: { key: 'room_off', params: {} }, tone: 'info' };

    const functions = functionsView(this.functions, this.bus);
    const promptSource = this.prompt
      ? activitySources(
          this.model,
          this.activities.find((a) => a.id === this.prompt!.activityId)!,
        ).find((s) => s.id === this.prompt!.sourceId)
      : undefined;

    return {
      roomName: this.opts.roomName,
      status: this.status,
      activities,
      volume: {
        available: this.volumeDevices.length > 0,
        level: this.volume,
        muted: this.muted,
        feedback: this.volumeFeedback,
      },
      ...(this.quickActions.length > 0
        ? {
            quickActions: this.quickActions.map((a) => ({
              id: a.id,
              label: QUICK_ACTIONS[a.id].label,
              icon: QUICK_ACTIONS[a.id].icon,
              kind: QUICK_ACTIONS[a.id].kind,
              active: quickActionActive(a, (d) => this.bus.getState(d)),
            })),
          }
        : {}),
      ui: this.model.settings.panel,
      message,
      prompt: this.prompt
        ? {
            id: this.prompt.id,
            text: {
              key: 'switch_source',
              params: { source: promptSource?.label ?? this.prompt.sourceId },
            },
            secondsLeft: this.secondsLeft(this.prompt.deadline),
          }
        : null,
      warning:
        this.warningDeadline !== null
          ? {
              text: { key: 'auto_off', params: {} },
              secondsLeft: this.secondsLeft(this.warningDeadline) ?? 0,
            }
          : null,
      ...(this.linking ? { linking: this.linking } : {}),
      ...(functions ? { functions } : {}),
    };
  }
}
