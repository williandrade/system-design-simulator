import {
  CanvasActionMarker,
  CanvasRequest,
  CanvasResult,
  canvasError,
  isCanvasReadRequest,
  isRecord,
  readCanvasRequest,
} from './canvas-mcp-contract';

const CANVAS_SOCKET_URL = 'ws://127.0.0.1:4301/canvas';
const PAIRING_TIMEOUT_MS = 5000;
const RENDER_TIMEOUT_MS = 2000;
const ACTION_DWELL_MS = 500;

interface CanvasSession {
  transport: CanvasTransport;
  canvasId: string;
  pairingTimer: ReturnType<typeof setTimeout>;
  hasState: boolean;
  inFlight: boolean;
  cancelPresentation?: () => void;
}

interface CanvasTransport {
  isOpen(): boolean;
  send(payload: string): void;
  close(): void;
}

interface DesktopCanvasMcp {
  pair(token: string, canvasId: string, code: string): Promise<boolean>;
  result(token: string, payload: string): Promise<boolean>;
  disconnect(token: string): Promise<boolean>;
  subscribe(token: string, callback: (value: string | null) => void): () => void;
}

declare global {
  interface Window {
    simulatorCanvasMcp?: DesktopCanvasMcp;
  }
}

interface CanvasHost {
  activeCanvasId(): string | undefined;
  apply(request: CanvasRequest): CanvasResult;
  renderAction(): void;
  hasRenderedAction(marker: CanvasActionMarker): boolean;
}

export class CanvasMcpConnection {
  status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  message = 'Pair a local MCP client to this canvas.';
  lastAction?: CanvasActionMarker;

  private session?: CanvasSession;

  constructor(
    private readonly host: CanvasHost,
    private readonly run: (callback: () => void) => void = (callback) => callback(),
  ) {}

  static canConnect(window: Window): boolean {
    if (window.simulatorCanvasMcp) return true;
    // Chromium dev and Electron dev use the same Angular build. The desktop
    // window must not use the web relay when the native bridge is missing.
    if (window.navigator?.userAgent.includes('Electron/')) return false;
    return window.location.origin === 'http://localhost:4200' ||
      window.location.origin === 'http://127.0.0.1:4200';
  }

  connect(code: string): void {
    const canvasId = this.host.activeCanvasId();
    if (
      this.session ||
      !canvasId ||
      !CanvasMcpConnection.canConnect(window)
    ) {
      return;
    }
    const pairingCode = code.trim();
    if (!pairingCode || pairingCode.length > 128) {
      this.message = 'Enter the pairing code from your local MCP client.';
      return;
    }

    const bridge = window.simulatorCanvasMcp;
    if (bridge) {
      this.connectDesktop(bridge, canvasId, pairingCode);
    } else {
      this.connectWeb(canvasId, pairingCode);
    }
  }

  private startSession(canvasId: string, transport: CanvasTransport): CanvasSession {
    const session: CanvasSession = {
      transport,
      canvasId,
      pairingTimer: setTimeout(
        () => this.close(session, 'Pairing timed out. Request a fresh code.'),
        PAIRING_TIMEOUT_MS,
      ),
      hasState: false,
      inFlight: false,
    };
    this.session = session;
    this.status = 'connecting';
    this.message = 'Connecting to the local MCP server…';
    return session;
  }

  private connectWeb(canvasId: string, pairingCode: string): void {
    const socket = new WebSocket(CANVAS_SOCKET_URL);
    const session = this.startSession(canvasId, {
      isOpen: () => socket.readyState === WebSocket.OPEN,
      send: (payload) => socket.send(payload),
      close() {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        if (socket.readyState < WebSocket.CLOSING) socket.close();
      },
    });
    socket.onopen = () => {
      if (!this.isCurrent(session)) return;
      socket.send(JSON.stringify({ version: 1, type: 'pair', code: pairingCode, canvasId }));
      socket.onopen = null;
    };
    socket.onmessage = (event: MessageEvent) => {
      void this.receive(session, event.data);
    };
    socket.onerror = () => this.close(session, 'The local MCP connection failed.');
    socket.onclose = (event) => {
      const message =
        this.status === 'connecting' && event.code === 1008
          ? 'Pairing was refused. Request a fresh code.'
          : 'The local MCP connection ended.';
      this.close(session, message);
    };
  }

  private connectDesktop(bridge: DesktopCanvasMcp, canvasId: string, pairingCode: string): void {
    const token = crypto.randomUUID();
    let open = true;
    const session = this.startSession(canvasId, {
      isOpen: () => open,
      send: (payload) => {
        void bridge.result(token, payload).then(
          (accepted) => { if (!accepted) failed(); },
          failed,
        );
      },
      close: () => {
        open = false;
        unsubscribe();
        void bridge.disconnect(token).catch(() => {});
      },
    });
    const failed = () => this.run(() => this.close(session, 'The local MCP connection failed.'));
    const unsubscribe = bridge.subscribe(token, (value) => {
      this.run(() => {
        if (value === null) {
          this.close(session, 'The local MCP connection ended.');
        } else {
          void this.receive(session, value);
        }
      });
    });
    void bridge.pair(token, canvasId, pairingCode).then((accepted) => {
      if (!accepted) {
        this.close(session, 'Pairing was refused. Request a fresh code.');
      }
    }, failed);
  }

  disconnect(): void {
    if (this.session) this.close(this.session, 'Disconnected from the local MCP client.');
  }

  private isCurrent(session: CanvasSession): boolean {
    return (
      this.session === session &&
      session.transport.isOpen() &&
      this.host.activeCanvasId() === session.canvasId
    );
  }

  private close(session: CanvasSession, message: string): void {
    if (this.session !== session) return;
    this.session = undefined;
    clearTimeout(session.pairingTimer);
    session.cancelPresentation?.();
    session.transport.close();
    this.status = 'disconnected';
    this.message = message;
    this.lastAction = undefined;
  }

  private async receive(session: CanvasSession, value: unknown): Promise<void> {
    if (!this.isCurrent(session)) return;
    const message = this.parseMessage(value);
    if (
      message?.['type'] === 'paired' &&
      this.status === 'connecting' &&
      message['canvasId'] === session.canvasId
    ) {
      clearTimeout(session.pairingTimer);
      this.status = 'connected';
      this.message = 'Connected to this canvas.';
      return;
    }

    if (
      this.status !== 'connected' ||
      message?.['type'] !== 'request' ||
      message['canvasId'] !== session.canvasId ||
      session.inFlight
    ) {
      this.close(session, 'The local MCP server sent an unexpected message.');
      return;
    }

    const request = readCanvasRequest(message);
    if (!request) {
      const requestId = message['requestId'];
      if (typeof requestId !== 'string' || !requestId || requestId.length > 128) {
        this.close(session, 'The local MCP server sent an invalid request.');
        return;
      }
      this.sendResult(
        session,
        requestId,
        canvasError('INVALID_ARGUMENT', 'Invalid canvas tool or arguments.'),
      );
      return;
    }

    const read = isCanvasReadRequest(request);
    if (!read && !session.hasState) {
      this.sendResult(
        session,
        request.requestId,
        canvasError('INVALID_STATE', 'Read the canvas state before editing.'),
      );
      return;
    }
    if (!read && document.visibilityState !== 'visible') {
      this.sendResult(
        session,
        request.requestId,
        canvasError('TAB_HIDDEN', 'Show the canvas before editing.'),
      );
      return;
    }

    session.inFlight = true;
    try {
      // No asynchronous boundary separates the target/visibility checks from the mutation.
      const result = this.host.apply(request);
      if (result.ok && result.action) {
        const marker: CanvasActionMarker = {
          ...result.action,
          canvasId: session.canvasId,
          sequence: (this.lastAction?.sequence ?? 0) + 1,
        };
        this.lastAction = marker;
        this.host.renderAction();
        if (!(await this.waitForPresentation(session, marker))) {
          this.finishUnknown(session, request.requestId);
          return;
        }
      }
      if (result.ok && request.tool === 'get_canvas_state') session.hasState = true;
      this.sendResult(session, request.requestId, result);
    } catch {
      if (read) {
        this.sendResult(
          session,
          request.requestId,
          canvasError('INTERNAL_ERROR', 'Could not read the canvas.'),
        );
      } else {
        this.finishUnknown(session, request.requestId);
      }
    } finally {
      session.inFlight = false;
    }
  }

  private parseMessage(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'string') return undefined;
    try {
      const message: unknown = JSON.parse(value);
      return isRecord(message) && message['version'] === 1 ? message : undefined;
    } catch {
      return undefined;
    }
  }

  private sendResult(session: CanvasSession, requestId: string, result: CanvasResult): void {
    if (!this.isCurrent(session)) return;
    const outcome = result.ok
      ? { ok: true, data: result.data }
      : { ok: false, error: result.error };
    session.transport.send(
      JSON.stringify({
        version: 1,
        type: 'result',
        requestId,
        canvasId: session.canvasId,
        ...outcome,
      }),
    );
  }

  private finishUnknown(session: CanvasSession, requestId: string): void {
    const message =
      'The canvas change could not be confirmed. Reconnect and read the canvas state.';
    this.sendResult(session, requestId, canvasError('RESULT_UNKNOWN', message));
    this.close(session, message);
  }

  private waitForPresentation(
    session: CanvasSession,
    marker: CanvasActionMarker,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let frame = 0;
      let dwell: ReturnType<typeof setTimeout> | undefined;
      const visible = () => this.isCurrent(session) && document.visibilityState === 'visible';
      const finish = (presented: boolean) => {
        clearTimeout(timeout);
        clearTimeout(dwell);
        cancelAnimationFrame(frame);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        session.cancelPresentation = undefined;
        resolve(presented);
      };
      const onVisibilityChange = () => {
        if (!visible()) finish(false);
      };
      const timeout = setTimeout(() => finish(false), RENDER_TIMEOUT_MS);

      session.cancelPresentation = () => finish(false);
      document.addEventListener('visibilitychange', onVisibilityChange);
      const observeAction = () => {
        if (!visible()) {
          finish(false);
          return;
        }
        if (!this.host.hasRenderedAction(marker)) {
          frame = requestAnimationFrame(observeAction);
          return;
        }
        clearTimeout(timeout);
        dwell = setTimeout(
          () => finish(visible() && this.host.hasRenderedAction(marker)),
          ACTION_DWELL_MS,
        );
      };
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(observeAction);
      });
    });
  }
}
