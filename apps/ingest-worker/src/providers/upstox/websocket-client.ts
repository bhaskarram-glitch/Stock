import WebSocket, { RawData } from "ws";
import { logger } from "../../lib/logger.js";
import type { UpstoxClient } from "./client.js";
import {
  buildMarketDataFeedRequest,
  decodeMarketDataFeedResponse,
  extractTicksFromMarketDataFeedResponse,
  maskAuthorizedRedirectUri,
  type UpstoxV3FeedMode,
} from "./market-data-feed-v3.js";
import type { UpstoxWSTick } from "./types.js";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;

type MessageCallback = (error?: Error) => void;

export interface UpstoxWebSocketLike {
  readyState: number;
  on(event: "open", listener: () => void): this;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "pong", listener: () => void): this;
  on(
    event: "close",
    listener: (code: number, reason: Buffer) => void,
  ): this;
  close(code?: number, reason?: string): void;
  ping(): void;
  send(data: Buffer, callback?: MessageCallback): void;
  /** Hard-closes a dead socket (ws has it). Without it the pong-timeout check is skipped. */
  terminate?(): void;
}

export interface WebSocketClientOptions {
  upstoxClient: Pick<UpstoxClient, "authorizeMarketDataFeed">;
  /** Name used in logs (account alias). */
  label?: string;
  /** Give up after this many failed reconnects in a row. Default 0 = never give up (Bug #8). */
  reconnectAttempts?: number;
  /** First reconnect delay; doubles per attempt up to maxReconnectDelay. Default 2s. */
  reconnectDelay?: number;
  /** Cap for the reconnect delay. Default 60s. */
  maxReconnectDelay?: number;
  /**
   * Ping interval. If neither a pong nor any message arrived since the previous ping, the socket is
   * treated as dead, terminated and reconnected (Bug #12). Default 15s.
   */
  heartbeatInterval?: number;
  /** Keys per subscribe frame. Default 500. */
  subscribeChunkSize?: number;
  subscriptionMode?: UpstoxV3FeedMode;
  onTick?: (tick: UpstoxWSTick) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  socketFactory?: (url: string) => UpstoxWebSocketLike;
}

function defaultSocketFactory(url: string): UpstoxWebSocketLike {
  return new WebSocket(url);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
  }

  return Buffer.from(data);
}

export class UpstoxWebSocketClient {
  private ws: UpstoxWebSocketLike | null = null;
  private readonly upstoxClient: Pick<UpstoxClient, "authorizeMarketDataFeed">;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly subscribeChunkSize: number;
  private readonly label: string;
  private awaitingPong = false;
  private readonly heartbeatInterval: number;
  private readonly subscriptionMode: UpstoxV3FeedMode;
  private readonly socketFactory: (url: string) => UpstoxWebSocketLike;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private isConnected = false;
  private isConnecting = false;
  private manuallyDisconnected = false;
  private connectionGeneration = 0;
  private subscribedInstruments = new Set<string>();

  private readonly onTick?: (tick: UpstoxWSTick) => void;
  private readonly onError?: (error: Error) => void;
  private readonly onConnect?: () => void;
  private readonly onDisconnect?: () => void;

  constructor(options: WebSocketClientOptions) {
    this.upstoxClient = options.upstoxClient;
    this.maxReconnectAttempts = options.reconnectAttempts || Infinity;
    this.reconnectDelay = options.reconnectDelay || 2000;
    this.maxReconnectDelay = options.maxReconnectDelay || 60_000;
    this.heartbeatInterval = options.heartbeatInterval || 15_000;
    this.subscribeChunkSize = options.subscribeChunkSize || 500;
    this.label = options.label || "ws";
    this.subscriptionMode = options.subscriptionMode || "full";
    this.socketFactory = options.socketFactory || defaultSocketFactory;

    this.onTick = options.onTick;
    this.onError = options.onError;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
  }

  connect(): void {
    if (
      this.isConnecting ||
      this.isConnected ||
      (this.ws &&
        (this.ws.readyState === SOCKET_CONNECTING ||
          this.ws.readyState === SOCKET_OPEN))
    ) {
      logger.debug("WebSocket already connected or connecting", { account: this.label });
      return;
    }

    this.manuallyDisconnected = false;
    const generation = ++this.connectionGeneration;
    void this.openAuthorizedSocket(generation);
  }

  disconnect(): void {
    logger.info("Disconnecting from Upstox WebSocket", { account: this.label });

    this.manuallyDisconnected = true;
    this.connectionGeneration++;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();

    const socket = this.ws;
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.subscribedInstruments.clear();

    if (
      socket &&
      (socket.readyState === SOCKET_OPEN ||
        socket.readyState === SOCKET_CONNECTING ||
        socket.readyState === SOCKET_CLOSING)
    ) {
      socket.close(1000, "Client disconnect");
    }

    if (this.onDisconnect) {
      this.onDisconnect();
    }
  }

  subscribe(instruments: string[]): void {
    if (!this.isConnected || !this.ws || this.ws.readyState !== SOCKET_OPEN) {
      logger.warn("Cannot subscribe - WebSocket not connected", { account: this.label });
      return;
    }

    const newInstruments = Array.from(new Set(instruments)).filter(
      (inst) => !this.subscribedInstruments.has(inst),
    );

    if (newInstruments.length === 0) {
      logger.debug("All instruments already subscribed", { account: this.label });
      return;
    }

    logger.info("Subscribing to instruments", {
      account: this.label,
      count: newInstruments.length,
      mode: this.subscriptionMode,
    });

    for (let i = 0; i < newInstruments.length; i += this.subscribeChunkSize) {
      const chunk = newInstruments.slice(i, i + this.subscribeChunkSize);
      const request = buildMarketDataFeedRequest(
        "sub",
        chunk,
        this.subscriptionMode,
      );
      this.ws.send(request, (error) => {
        if (error) {
          this.handleError(
            new Error(`Failed to send subscription request: ${error.message}`),
          );
          return;
        }
        chunk.forEach((inst) => this.subscribedInstruments.add(inst));
      });
    }
  }

  unsubscribe(instruments: string[]): void {
    if (!this.isConnected || !this.ws || this.ws.readyState !== SOCKET_OPEN) {
      logger.warn("Cannot unsubscribe - WebSocket not connected");
      return;
    }

    const instrumentsToUnsubscribe = instruments.filter((inst) =>
      this.subscribedInstruments.has(inst),
    );

    if (instrumentsToUnsubscribe.length === 0) {
      logger.info("No instruments to unsubscribe");
      return;
    }

    logger.info("Unsubscribing from instruments", {
      account: this.label,
      count: instrumentsToUnsubscribe.length,
    });

    const request = buildMarketDataFeedRequest(
      "unsub",
      instrumentsToUnsubscribe,
    );

    this.ws.send(request, (error) => {
      if (error) {
        this.handleError(
          new Error(`Failed to send unsubscribe request: ${error.message}`),
        );
        return;
      }

      instrumentsToUnsubscribe.forEach((inst) =>
        this.subscribedInstruments.delete(inst),
      );
    });
  }

  isWebSocketConnected(): boolean {
    return this.isConnected && this.ws?.readyState === SOCKET_OPEN;
  }

  getSubscribedInstruments(): string[] {
    return Array.from(this.subscribedInstruments);
  }

  private async openAuthorizedSocket(generation: number): Promise<void> {
    this.isConnecting = true;

    try {
      const authorizedUrl = await this.upstoxClient.authorizeMarketDataFeed();
      if (this.manuallyDisconnected || generation !== this.connectionGeneration) {
        this.isConnecting = false;
        return;
      }

      logger.info("Connecting to Upstox V3 market data feed", {
        account: this.label,
        url: maskAuthorizedRedirectUri(authorizedUrl),
      });

      const socket = this.socketFactory(authorizedUrl);
      this.ws = socket;
      this.setupEventHandlers(socket, generation);
    } catch (error) {
      this.isConnecting = false;
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to authorize Upstox V3 WebSocket connection", {
        account: this.label,
        error: normalizedError.message,
      });
      this.handleError(normalizedError);
      if (!this.manuallyDisconnected) {
        this.attemptReconnect();
      }
    }
  }

  private setupEventHandlers(
    socket: UpstoxWebSocketLike,
    generation: number,
  ): void {
    socket.on("open", () => {
      if (socket !== this.ws || generation !== this.connectionGeneration) {
        return;
      }

      logger.info("Upstox V3 WebSocket connection opened", { account: this.label });
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      this.startHeartbeat();

      if (this.onConnect) {
        this.onConnect();
      }
    });

    socket.on("message", (data, isBinary) => {
      if (socket !== this.ws || generation !== this.connectionGeneration) {
        return;
      }

      this.awaitingPong = false; // any traffic proves the socket is alive
      const buffer = toBuffer(data);

      try {
        if (!isBinary) {
          logger.warn("Received unexpected text WebSocket message", {
            account: this.label,
            message: buffer.toString("utf8").slice(0, 500),
          });
          return;
        }

        const response = decodeMarketDataFeedResponse(buffer);
        const ticks = extractTicksFromMarketDataFeedResponse(response);

        if (ticks.length === 0) {
          logger.debug("Received Upstox V3 feed message without tick payload", {
            account: this.label,
            type: response.type,
            segments: Object.keys(response.marketInfo?.segmentStatus ?? {}),
          });
          return;
        }

        ticks.forEach((tick) => this.onTick?.(tick));
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        logger.error("Failed to decode Upstox V3 WebSocket message", {
          account: this.label,
          error: normalizedError.message,
          bytes: buffer.length,
        });
        this.handleError(normalizedError);
      }
    });

    socket.on("error", (error) => {
      if (socket !== this.ws || generation !== this.connectionGeneration) {
        return;
      }

      logger.error("WebSocket error", { account: this.label, error: error.message });
      this.handleError(error);
    });

    socket.on("pong", () => {
      if (socket === this.ws) this.awaitingPong = false;
    });

    socket.on("close", (code, reason) => {
      if (socket === this.ws) {
        this.ws = null;
      }

      if (generation !== this.connectionGeneration) {
        return;
      }

      logger.info("WebSocket connection closed", {
        account: this.label,
        code,
        reason: reason.toString(),
      });

      this.isConnected = false;
      this.isConnecting = false;
      this.subscribedInstruments.clear();
      this.clearHeartbeatTimer();

      if (this.onDisconnect) {
        this.onDisconnect();
      }

      // Reconnect after ANY close we did not ask for — a server-side 1000 close mid-session too.
      if (!this.manuallyDisconnected) {
        this.attemptReconnect();
      }
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();

    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      const socket = this.ws;
      if (!socket || socket.readyState !== SOCKET_OPEN) return;
      if (this.awaitingPong && socket.terminate) {
        logger.warn("WebSocket heartbeat timed out; reconnecting", {
          account: this.label,
          silentForMs: this.heartbeatInterval,
        });
        socket.terminate(); // emits close (1006) → attemptReconnect
        return;
      }
      this.awaitingPong = true;
      socket.ping();
    }, this.heartbeatInterval);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("Max reconnection attempts reached", {
        account: this.label,
        attempts: this.reconnectAttempts,
      });
      this.handleError(new Error("Max reconnection attempts reached"));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.maxReconnectDelay,
      this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 20)),
    );

    logger.info("Attempting WebSocket reconnection", {
      account: this.label,
      attempt: this.reconnectAttempts,
      delay,
    });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private handleError(error: Error): void {
    if (this.onError) {
      this.onError(error);
    }
  }
}

export type { UpstoxWSTick } from "./types.js";
