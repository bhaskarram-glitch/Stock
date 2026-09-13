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
  on(
    event: "close",
    listener: (code: number, reason: Buffer) => void,
  ): this;
  close(code?: number, reason?: string): void;
  ping(): void;
  send(data: Buffer, callback?: MessageCallback): void;
}

export interface WebSocketClientOptions {
  upstoxClient: Pick<UpstoxClient, "authorizeMarketDataFeed">;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  heartbeatInterval?: number;
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
    this.maxReconnectAttempts = options.reconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 2000;
    this.heartbeatInterval = options.heartbeatInterval || 30000;
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
      logger.warn("WebSocket already connected or connecting");
      return;
    }

    this.manuallyDisconnected = false;
    const generation = ++this.connectionGeneration;
    void this.openAuthorizedSocket(generation);
  }

  disconnect(): void {
    logger.info("Disconnecting from Upstox WebSocket");

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
      logger.warn("Cannot subscribe - WebSocket not connected");
      return;
    }

    const newInstruments = instruments.filter(
      (inst) => !this.subscribedInstruments.has(inst),
    );

    if (newInstruments.length === 0) {
      logger.info("All instruments already subscribed");
      return;
    }

    logger.info("Subscribing to instruments", {
      instruments: newInstruments,
      mode: this.subscriptionMode,
    });

    const request = buildMarketDataFeedRequest(
      "sub",
      newInstruments,
      this.subscriptionMode,
    );

    this.ws.send(request, (error) => {
      if (error) {
        this.handleError(
          new Error(`Failed to send subscription request: ${error.message}`),
        );
        return;
      }

      newInstruments.forEach((inst) => this.subscribedInstruments.add(inst));
    });
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
      instruments: instrumentsToUnsubscribe,
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

      logger.info("Upstox V3 WebSocket connection opened");
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

      const buffer = toBuffer(data);

      try {
        if (!isBinary) {
          logger.warn("Received unexpected text WebSocket message", {
            message: buffer.toString("utf8"),
          });
          return;
        }

        const response = decodeMarketDataFeedResponse(buffer);
        const ticks = extractTicksFromMarketDataFeedResponse(response);

        if (ticks.length === 0) {
          logger.info("Received Upstox V3 feed message without tick payload", {
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

      logger.error("WebSocket error", { error: error.message });
      this.handleError(error);
    });

    socket.on("close", (code, reason) => {
      if (socket === this.ws) {
        this.ws = null;
      }

      if (generation !== this.connectionGeneration) {
        return;
      }

      logger.info("WebSocket connection closed", {
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

      if (!this.manuallyDisconnected && code !== 1000) {
        this.attemptReconnect();
      }
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === SOCKET_OPEN) {
        this.ws.ping();
      }
    }, this.heartbeatInterval);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("Max reconnection attempts reached", {
        attempts: this.reconnectAttempts,
      });
      this.handleError(new Error("Max reconnection attempts reached"));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    logger.info("Attempting WebSocket reconnection", {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
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
