import {
  ClientEvent,
  EventType,
  IndexedDBStore,
  MatrixClient,
  MatrixEvent,
  MatrixScheduler,
  OAuth2,
  RelationType,
  RoomEvent,
  RoomMemberEvent,
  SyncState,
  createClient,
  type IPusherRequest,
  type Room,
} from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from "matrix-js-sdk/lib/crypto-api/verification";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/key-passphrase";
import { decryptAttachment, encryptAttachment, type IEncryptedFile } from "matrix-encrypt-attachment";
import { base64UrlToBytes, clearSession, saveSession } from "./session-store";
import { humanizeMatrixError } from "./auth";
import { imageDimensions, normalizeMediaFile } from "./media";
import { normalizeRooms, normalizeTimeline } from "./normalize";
import { createMediaContent, createTextContent } from "./message-content";
import type { DeviceSummary, DeviceVerificationState, MatrixMediaRef, MatrixSnapshot, MediaAsset, PersistedMatrixSession, TimelineItem } from "./types";

type Listener = () => void;

export class MatrixAlreadyOpenError extends Error {
  constructor() {
    super("Sub-Etha is already tuned to this account in another tab.");
  }
}

function stableStoreName(session: PersistedMatrixSession): string {
  return `${session.userId}-${session.deviceId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function emptySnapshot(session: PersistedMatrixSession): MatrixSnapshot {
  return {
    connection: "starting",
    rooms: [],
    activeRoomId: null,
    timeline: [],
    typingNames: [],
    loadingHistory: false,
    error: null,
    userId: session.userId,
    displayName: session.userId,
    avatarMxcUrl: null,
    deviceId: session.deviceId,
    verification: null,
  };
}

interface ActiveVerification {
  request: VerificationRequest;
  direction: "incoming" | "outgoing";
  verifierStarted: boolean;
  verifier: Verifier | null;
  sasCallbacks: ShowSasCallbacks | null;
  requestChange: () => void;
  showSas: ((callbacks: ShowSasCallbacks) => void) | null;
}

async function acquireExclusiveLock(name: string): Promise<(() => void) | null> {
  if (!("locks" in navigator)) return () => undefined;
  let releaseLock: (() => void) | undefined;
  let resolveAcquired: (acquired: boolean) => void = () => undefined;
  const acquired = new Promise<boolean>((resolve) => { resolveAcquired = resolve; });
  const held = new Promise<void>((resolve) => { releaseLock = resolve; });
  void navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
    resolveAcquired(Boolean(lock));
    if (lock) await held;
  });
  if (!(await acquired)) return null;
  return () => releaseLock?.();
}

async function messageInfo(file: File): Promise<Record<string, unknown>> {
  const info: Record<string, unknown> = { size: file.size, mimetype: file.type || "application/octet-stream" };
  const dimensions = await imageDimensions(file);
  if (dimensions.width) info.w = dimensions.width;
  if (dimensions.height) info.h = dimensions.height;
  return info;
}

export function mediaAuthorizationHeaders(url: string, homeserverUrl: string, accessToken: string | null): HeadersInit | undefined {
  if (!accessToken) return undefined;
  if (new URL(url).origin !== new URL(homeserverUrl).origin) {
    throw new Error("Refusing to send Matrix credentials to an unexpected media host.");
  }
  return { Authorization: `Bearer ${accessToken}` };
}

export function shouldTryLegacyMedia(status: number): boolean {
  return [400, 404, 405, 501].includes(status);
}

export function findOwnReactionEventId(timeline: TimelineItem[], eventId: string, key: string): string | null {
  return timeline.find((item) => item.id === eventId)?.reactions
    .find((reaction) => reaction.key === key && reaction.mine)?.ownEventId ?? null;
}

export class MatrixService {
  private client: MatrixClient | null = null;
  private store: IndexedDBStore | null = null;
  private session: PersistedMatrixSession;
  private snapshot: MatrixSnapshot;
  private listeners = new Set<Listener>();
  private releaseLock: (() => void) | null = null;
  private mediaAssets = new Map<string, Promise<MediaAsset>>();
  private gifPosters = new Map<string, Promise<string | null>>();
  private secretStorageKey: [string, Uint8Array<ArrayBuffer>] | null = null;
  private activeVerification: ActiveVerification | null = null;
  private stopped = false;
  private readonly takeoverStorageKey = "sub-etha-account-takeover";

  constructor(session: PersistedMatrixSession) {
    this.session = session;
    this.snapshot = emptySnapshot(session);
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MatrixSnapshot => this.snapshot;

  private emit(next: Partial<MatrixSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private requireClient(): MatrixClient {
    if (!this.client) throw new Error("The Matrix client is not ready yet.");
    return this.client;
  }

  private async refreshTokens(refreshToken: string) {
    if (this.session.authKind === "oauth" && this.session.oauth) {
      const oauth = new OAuth2(this.session.oauth.metadata, {
        clientId: this.session.oauth.clientId,
        deviceId: this.session.oauth.deviceId,
        redirectUri: this.session.oauth.redirectUri,
      });
      const response = await oauth.performRefreshTokenGrant(refreshToken);
      this.session = {
        ...this.session,
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? refreshToken,
        expiresAt: response.expires_in ? Date.now() + response.expires_in * 1000 : undefined,
      };
    } else {
      const response = await createClient({ baseUrl: this.session.baseUrl, disableVoip: true }).refreshToken(refreshToken);
      this.session = {
        ...this.session,
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? refreshToken,
        expiresAt: Date.now() + response.expires_in_ms,
      };
    }
    await saveSession(this.session);
    return {
      accessToken: this.session.accessToken,
      refreshToken: this.session.refreshToken,
      expiry: this.session.expiresAt ? new Date(this.session.expiresAt) : undefined,
    };
  }

  async start(): Promise<void> {
    const storeName = stableStoreName(this.session);
    this.releaseLock = await acquireExclusiveLock(`sub-etha-matrix-${storeName}`);
    if (!this.releaseLock) throw new MatrixAlreadyOpenError();

    this.store = new IndexedDBStore({ indexedDB: window.indexedDB, dbName: `sub-etha-sync-${storeName}` });
    const scheduler = new MatrixScheduler();
    this.client = createClient({
      baseUrl: this.session.baseUrl,
      userId: this.session.userId,
      deviceId: this.session.deviceId,
      accessToken: this.session.accessToken,
      refreshToken: this.session.refreshToken,
      tokenRefreshFunction: (token) => this.refreshTokens(token),
      store: this.store,
      scheduler,
      timelineSupport: true,
      disableVoip: true,
      localTimeoutMs: 30_000,
      verificationMethods: ["m.sas.v1"],
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          if (this.secretStorageKey && keys[this.secretStorageKey[0]]) return this.secretStorageKey;
          return null;
        },
        cacheSecretStorageKey: (keyId, _keyInfo, key) => {
          this.secretStorageKey = [keyId, key];
        },
      },
    });

    await this.store.startup();
    await this.client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: `sub-etha-crypto-${storeName}`,
      storageKey: base64UrlToBytes(this.session.cryptoStorageKey),
    });

    this.client.on(ClientEvent.Sync, this.handleSync);
    this.client.on(RoomEvent.Timeline, this.handleTimeline);
    this.client.on(RoomEvent.Name, this.handleRoomChange);
    this.client.on(RoomEvent.Receipt, this.handleRoomChange);
    this.client.on(RoomEvent.MyMembership, this.handleRoomChange);
    this.client.on(RoomMemberEvent.Typing, this.handleTyping);
    this.client.on(CryptoEvent.VerificationRequestReceived, this.handleIncomingVerification);
    window.addEventListener("storage", this.handleTakeoverRequest);
    this.client.startClient({
      initialSyncLimit: 30,
      lazyLoadMembers: true,
      pendingEventOrdering: "chronological" as never,
      disablePresence: true,
      clientWellKnownPollPeriod: 6 * 60 * 60,
    });
    this.refreshDerivedState();
    void this.refreshOwnProfile();
  }

  private handleSync = (state: SyncState): void => {
    if (this.stopped) return;
    if (state === SyncState.Prepared || state === SyncState.Syncing) this.emit({ connection: "ready", error: null });
    else if (state === SyncState.Catchup || state === SyncState.Reconnecting) this.emit({ connection: "catching-up" });
    else if (state === SyncState.Error) this.emit({ connection: navigator.onLine ? "error" : "offline" });
    else if (state === SyncState.Stopped) this.emit({ connection: "idle" });
    this.refreshDerivedState();
  };

  private handleTimeline = (_event: MatrixEvent, room: Room | undefined): void => {
    if (this.stopped) return;
    this.refreshDerivedState(room?.roomId === this.snapshot.activeRoomId);
  };

  private handleRoomChange = (): void => {
    if (!this.stopped) this.refreshDerivedState(true);
  };

  private handleTyping = (): void => {
    if (!this.stopped) this.refreshTyping();
  };

  private handleTakeoverRequest = (event: StorageEvent): void => {
    if (event.key !== this.takeoverStorageKey || !event.newValue || this.stopped) return;
    this.emit({ connection: "idle", error: "This receiver was safely released for another tab." });
    this.stop();
  };

  private verificationState(
    context: ActiveVerification,
    stage: DeviceVerificationState["stage"],
    next: Partial<DeviceVerificationState> = {},
  ): DeviceVerificationState {
    return {
      transactionId: context.request.transactionId ?? null,
      direction: context.direction,
      otherUserId: context.request.otherUserId,
      otherDeviceId: context.request.otherDeviceId ?? null,
      stage,
      emojis: [],
      ...next,
    };
  }

  private handleIncomingVerification = (request: VerificationRequest): void => {
    if (!request.isSelfVerification || !request.pending || this.stopped) return;
    if (this.activeVerification?.request === request) return;
    if (this.activeVerification?.request.pending) {
      void request.cancel();
      return;
    }
    const context = this.bindVerification(request, "incoming");
    this.emit({
      verification: this.verificationState(context, "incoming", {
        message: "Another Sub-Etha receiver wants to verify this device.",
      }),
    });
    this.handleVerificationChange(request);
  };

  private bindVerification(request: VerificationRequest, direction: "incoming" | "outgoing"): ActiveVerification {
    this.releaseVerificationContext();
    const requestChange = () => this.handleVerificationChange(request);
    const context: ActiveVerification = {
      request,
      direction,
      verifierStarted: false,
      verifier: null,
      sasCallbacks: null,
      requestChange,
      showSas: null,
    };
    this.activeVerification = context;
    request.on(VerificationRequestEvent.Change, requestChange);
    return context;
  }

  private handleVerificationChange(request: VerificationRequest): void {
    const context = this.activeVerification;
    if (!context || context.request !== request) return;
    if (request.phase === VerificationPhase.Cancelled) {
      this.finishVerification("cancelled", "The verification was cancelled on one of your devices.");
      return;
    }
    if (request.phase === VerificationPhase.Done) {
      this.finishVerification("complete", "These two Sub-Etha receivers now trust one another.");
      return;
    }
    if (request.phase === VerificationPhase.Started) {
      void this.runVerifier(context);
      return;
    }
    if (request.phase === VerificationPhase.Ready && context.direction === "outgoing") {
      void this.runVerifier(context);
      return;
    }
    const current = this.snapshot.verification;
    if (current && current.stage !== "comparing") {
      this.emit({ verification: this.verificationState(context, current.stage, { message: current.message }) });
    }
  }

  private async runVerifier(context: ActiveVerification): Promise<void> {
    if (this.activeVerification !== context || context.verifierStarted) return;
    context.verifierStarted = true;
    try {
      const verifier = context.request.verifier
        ?? (context.request.phase === VerificationPhase.Ready
          ? await context.request.startVerification("m.sas.v1")
          : null);
      if (!verifier) {
        context.verifierStarted = false;
        return;
      }
      if (this.activeVerification !== context) return;
      context.verifier = verifier;
      const showSas = (callbacks: ShowSasCallbacks) => {
        if (this.activeVerification !== context) return;
        context.sasCallbacks = callbacks;
        this.emit({
          verification: this.verificationState(context, "comparing", {
            emojis: callbacks.sas.emoji ?? [],
            decimals: callbacks.sas.decimal,
            message: "Compare this sequence on both devices. Order matters; improbable hats do not.",
          }),
        });
      };
      context.showSas = showSas;
      verifier.on(VerifierEvent.ShowSas, showSas);
      this.emit({
        verification: this.verificationState(context, "waiting", {
          message: "The devices are negotiating a short, reassuring sequence of emoji.",
        }),
      });
      const currentSas = verifier.getShowSasCallbacks();
      if (currentSas) showSas(currentSas);
      await verifier.verify();
      if (this.activeVerification === context) {
        this.finishVerification("complete", "These two Sub-Etha receivers now trust one another.");
      }
    } catch (error) {
      if (this.activeVerification !== context) return;
      if (context.request.phase === VerificationPhase.Cancelled) {
        this.finishVerification("cancelled", "The verification was cancelled on one of your devices.");
      } else {
        this.finishVerification("error", humanizeMatrixError(error));
      }
    }
  }

  private releaseVerificationContext(): void {
    const context = this.activeVerification;
    if (!context) return;
    context.request.off(VerificationRequestEvent.Change, context.requestChange);
    if (context.verifier && context.showSas) context.verifier.off(VerifierEvent.ShowSas, context.showSas);
    this.activeVerification = null;
  }

  private finishVerification(stage: "complete" | "cancelled" | "error", message: string): void {
    const context = this.activeVerification;
    if (!context) return;
    const state = this.verificationState(context, stage, { message });
    this.releaseVerificationContext();
    this.emit({ verification: state });
  }

  private refreshDerivedState(includeTimeline = true): void {
    const client = this.client;
    if (!client) return;
    const rooms = normalizeRooms(client);
    let activeRoomId = this.snapshot.activeRoomId;
    if (activeRoomId && !rooms.some((room) => room.id === activeRoomId)) activeRoomId = null;
    const room = activeRoomId ? client.getRoom(activeRoomId) : null;
    this.emit({
      rooms,
      activeRoomId,
      timeline: includeTimeline && room ? normalizeTimeline(room, client) : this.snapshot.timeline,
    });
    this.refreshTyping();
  }

  private async refreshOwnProfile(): Promise<void> {
    const client = this.client;
    const userId = client?.getUserId();
    if (!client || !userId) return;
    try {
      const profile = await client.getProfileInfo(userId);
      this.emit({
        displayName: profile.displayname || userId,
        avatarMxcUrl: profile.avatar_url ?? null,
      });
    } catch {
      const user = client.getUser(userId);
      this.emit({
        displayName: user?.displayName || userId,
        avatarMxcUrl: user?.avatarUrl ?? null,
      });
    }
  }

  private refreshTyping(): void {
    const client = this.client;
    const room = client && this.snapshot.activeRoomId ? client.getRoom(this.snapshot.activeRoomId) : null;
    const ownUserId = client?.getUserId();
    const typingNames = room
      ? room.getMembers().filter((member) => member.typing && member.userId !== ownUserId).map((member) => member.name || member.userId)
      : [];
    if (typingNames.join("\u0000") !== this.snapshot.typingNames.join("\u0000")) this.emit({ typingNames });
  }

  selectRoom(roomId: string | null): void {
    const client = this.requireClient();
    const room = roomId ? client.getRoom(roomId) : null;
    this.emit({
      activeRoomId: room?.roomId ?? null,
      timeline: room ? normalizeTimeline(room, client) : [],
      error: null,
    });
    this.refreshTyping();
    if (room) void this.markRoomRead(room.roomId);
  }

  clearError(): void {
    if (this.snapshot.error) this.emit({ error: null });
  }

  async paginate(): Promise<void> {
    const client = this.requireClient();
    const room = this.snapshot.activeRoomId ? client.getRoom(this.snapshot.activeRoomId) : null;
    if (!room || this.snapshot.loadingHistory) return;
    this.emit({ loadingHistory: true });
    try {
      await client.scrollback(room, 40);
      this.emit({ timeline: normalizeTimeline(room, client), loadingHistory: false });
    } catch (error) {
      this.emit({ loadingHistory: false, error: humanizeMatrixError(error) });
    }
  }

  async sendText(body: string, options: { replyTo?: string; editEventId?: string } = {}): Promise<void> {
    const client = this.requireClient();
    const roomId = this.snapshot.activeRoomId;
    if (!roomId || !body.trim()) return;
    const room = client.getRoom(roomId);
    const replyUserId = options.replyTo ? room?.findEventById(options.replyTo)?.getSender() : undefined;
    const content = createTextContent(body, { ...options, replyUserId });
    try {
      await client.sendMessage(roomId, content as never);
    } catch (error) {
      this.emit({ error: humanizeMatrixError(error) });
      throw error;
    }
  }

  async sendFile(
    sourceFile: File,
    options: { caption?: string; replyTo?: string } = {},
    onProgress?: (percentage: number) => void,
    onCancellable?: (cancel: (() => void) | null) => void,
  ): Promise<void> {
    const client = this.requireClient();
    const roomId = this.snapshot.activeRoomId;
    if (!roomId) return;
    const room = client.getRoom(roomId);
    if (!room) return;
    const file = await normalizeMediaFile(sourceFile);
    const encrypted = room.hasEncryptionStateEvent();
    let uploadBody: Blob = file;
    let encryptedFile: IEncryptedFile | undefined;
    if (encrypted) {
      const result = await encryptAttachment(await file.arrayBuffer());
      uploadBody = new Blob([result.data], { type: "application/octet-stream" });
      encryptedFile = result.info;
    }
    const uploadPromise = client.uploadContent(uploadBody, {
      name: file.name,
      type: encrypted ? "application/octet-stream" : file.type,
      progressHandler: (progress) => {
        const total = progress.total || file.size;
        onProgress?.(total ? Math.round((progress.loaded / total) * 100) : 0);
      },
    });
    onCancellable?.(() => { client.cancelUpload(uploadPromise); });
    const upload = await uploadPromise.finally(() => onCancellable?.(null));
    const content = createMediaContent({
      fileName: file.name,
      mimeType: file.type,
      contentUri: upload.content_uri,
      info: await messageInfo(file),
      caption: options.caption,
      replyTo: options.replyTo,
      encryptedFile: encryptedFile as unknown as Record<string, unknown> | undefined,
    });
    await client.sendMessage(roomId, content as never);
  }

  async getMediaAsset(
    media: MatrixMediaRef,
    options: { width?: number; height?: number; resizeMethod?: "crop" | "scale"; cacheKey?: string } = {},
  ): Promise<MediaAsset> {
    const key = [options.cacheKey ?? media.mxcUrl, options.width ?? "full", options.height ?? "full", options.resizeMethod ?? "scale"].join("|");
    const existing = this.mediaAssets.get(key);
    if (existing) return existing;
    const loading = this.loadMedia(media, options);
    this.mediaAssets.set(key, loading);
    try {
      return await loading;
    } catch (error) {
      this.mediaAssets.delete(key);
      throw error;
    }
  }

  invalidateMedia(media: MatrixMediaRef, cacheKey?: string): void {
    const prefix = cacheKey ?? media.mxcUrl;
    for (const [key, promise] of this.mediaAssets) {
      if (!key.startsWith(`${prefix}|`)) continue;
      void promise.then((asset) => URL.revokeObjectURL(asset.url)).catch(() => undefined);
      this.mediaAssets.delete(key);
    }
    for (const [key, promise] of this.gifPosters) {
      if (!key.startsWith(`${prefix}|`)) continue;
      void promise.then((url) => { if (url) URL.revokeObjectURL(url); }).catch(() => undefined);
      this.gifPosters.delete(key);
    }
  }

  async getGifPoster(media: MatrixMediaRef, cacheKey?: string): Promise<string | null> {
    const key = `${cacheKey ?? media.mxcUrl}|poster`;
    const existing = this.gifPosters.get(key);
    if (existing) return existing;
    const loading = this.createGifPoster(media, cacheKey);
    this.gifPosters.set(key, loading);
    return loading;
  }

  private async createGifPoster(media: MatrixMediaRef, cacheKey?: string): Promise<string | null> {
    if (typeof document === "undefined") return null;
    try {
      const asset = await this.getMediaAsset(media, { cacheKey });
      let source: CanvasImageSource;
      let width: number;
      let height: number;
      let releaseSource: () => void = () => undefined;
      if ("createImageBitmap" in globalThis) {
        const bitmap = await createImageBitmap(asset.blob);
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
        releaseSource = () => bitmap.close();
      } else {
        const image = new Image();
        image.src = asset.url;
        await image.decode();
        source = image;
        width = image.naturalWidth;
        height = image.naturalHeight;
      }
      const scale = Math.min(1, 1000 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
      releaseSource();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      return blob ? URL.createObjectURL(blob) : null;
    } catch {
      return null;
    }
  }

  private async loadMedia(
    media: MatrixMediaRef,
    options: { width?: number; height?: number; resizeMethod?: "crop" | "scale" } = {},
  ): Promise<MediaAsset> {
    const client = this.requireClient();
    const useThumbnail = !media.encryptedFile && options.width && options.height;
    const authenticatedUrl = client.mxcUrlToHttp(
      media.mxcUrl,
      useThumbnail ? options.width : undefined,
      useThumbnail ? options.height : undefined,
      useThumbnail ? options.resizeMethod ?? "scale" : undefined,
      false,
      true,
      true,
    );
    if (!authenticatedUrl) throw new Error("The homeserver returned an invalid media address.");
    const token = client.getAccessToken();
    let response = await fetch(authenticatedUrl, {
      headers: mediaAuthorizationHeaders(authenticatedUrl, client.getHomeserverUrl(), token),
      cache: "no-store",
    });
    if (shouldTryLegacyMedia(response.status)) {
      const legacyUrl = client.mxcUrlToHttp(
        media.mxcUrl,
        useThumbnail ? options.width : undefined,
        useThumbnail ? options.height : undefined,
        useThumbnail ? options.resizeMethod ?? "scale" : undefined,
        false,
        false,
        false,
      );
      if (legacyUrl && legacyUrl !== authenticatedUrl) response = await fetch(legacyUrl, { cache: "no-store" });
    }
    if (!response.ok) throw new Error(`Media download failed (${response.status}).`);
    let bytes = await response.arrayBuffer();
    if (media.encryptedFile) bytes = await decryptAttachment(bytes, media.encryptedFile as unknown as IEncryptedFile);
    const mimeType = media.mimeType || response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    const blob = new Blob([bytes], { type: mimeType });
    return { url: URL.createObjectURL(blob), blob, mimeType, animated: mimeType === "image/gif" };
  }

  async toggleReaction(eventId: string, key: string): Promise<void> {
    const client = this.requireClient();
    const roomId = this.snapshot.activeRoomId;
    if (!roomId) return;
    const ownReactionEventId = findOwnReactionEventId(this.snapshot.timeline, eventId, key);
    if (ownReactionEventId) {
      await client.redactEvent(roomId, ownReactionEventId, undefined, { reason: "Reaction removed in Sub-Etha" });
      return;
    }
    await client.sendEvent(roomId, EventType.Reaction, {
      "m.relates_to": { rel_type: RelationType.Annotation, event_id: eventId, key },
    });
  }

  async redact(eventId: string): Promise<void> {
    const client = this.requireClient();
    if (!this.snapshot.activeRoomId) return;
    await client.redactEvent(this.snapshot.activeRoomId, eventId, undefined, { reason: "Removed in Sub-Etha" });
  }

  async retry(item: TimelineItem): Promise<void> {
    const client = this.requireClient();
    const room = this.snapshot.activeRoomId ? client.getRoom(this.snapshot.activeRoomId) : null;
    if (room) await client.resendEvent(item.event, room);
  }

  async markRoomRead(roomId: string): Promise<void> {
    const client = this.requireClient();
    const room = client.getRoom(roomId);
    const event = room?.getLiveTimeline().getEvents().toReversed().find((candidate) => candidate.getId());
    if (event?.getId()) {
      try { await client.setRoomReadMarkers(roomId, event.getId()!, event); } catch { /* best effort */ }
    }
  }

  async setTyping(typing: boolean): Promise<void> {
    const client = this.requireClient();
    if (!this.snapshot.activeRoomId) return;
    try { await client.sendTyping(this.snapshot.activeRoomId, typing, 5_000); } catch { /* ephemeral */ }
  }

  async joinRoom(roomIdOrAlias: string): Promise<void> {
    const room = await this.requireClient().joinRoom(roomIdOrAlias.trim());
    this.refreshDerivedState(true);
    this.selectRoom(room.roomId);
  }

  async createRoom(options: { name?: string; invite?: string; direct?: boolean; encrypted?: boolean }): Promise<string> {
    const invite = options.invite?.trim();
    const response = await this.requireClient().createRoom({
      name: options.name?.trim() || undefined,
      invite: invite ? [invite] : undefined,
      is_direct: Boolean(options.direct),
      preset: "trusted_private_chat" as never,
      initial_state: options.encrypted === false ? undefined : [{
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      }],
    });
    this.refreshDerivedState(true);
    this.selectRoom(response.room_id);
    return response.room_id;
  }

  async invite(userId: string): Promise<void> {
    if (!this.snapshot.activeRoomId) return;
    await this.requireClient().invite(this.snapshot.activeRoomId, userId.trim());
  }

  async leaveActiveRoom(): Promise<void> {
    if (!this.snapshot.activeRoomId) return;
    await this.requireClient().leave(this.snapshot.activeRoomId);
    this.selectRoom(null);
    this.refreshDerivedState(true);
  }

  async setRoomMuted(muted: boolean): Promise<void> {
    if (!this.snapshot.activeRoomId) return;
    await this.requireClient().setRoomMutePushRule("global", this.snapshot.activeRoomId, muted);
    this.refreshDerivedState();
  }

  async searchCurrentRoom(term: string): Promise<TimelineItem[]> {
    const client = this.requireClient();
    const roomId = this.snapshot.activeRoomId;
    if (!roomId || !term.trim()) return [];
    const response = await client.searchRoomEvents({ term: term.trim(), filter: { rooms: [roomId] } });
    const room = client.getRoom(roomId);
    if (!room) return [];
    const events = response.results.map((result) => result.context.getEvent()).filter(Boolean) as MatrixEvent[];
    const eventIds = new Set(events.map((event) => event.getId()));
    return normalizeTimeline(room, client).filter((item) => eventIds.has(item.id) || item.body.toLowerCase().includes(term.toLowerCase()));
  }

  async updateProfile(displayName: string, avatar?: File): Promise<void> {
    const client = this.requireClient();
    if (displayName.trim()) await client.setDisplayName(displayName.trim());
    if (avatar) {
      const upload = await client.uploadContent(avatar, { name: avatar.name, type: avatar.type });
      await client.setAvatarUrl(upload.content_uri);
    }
    this.refreshDerivedState(true);
    await this.refreshOwnProfile();
  }

  async getDevices(): Promise<DeviceSummary[]> {
    const client = this.requireClient();
    const cryptoApi = client.getCrypto();
    const response = await client.getDevices();
    return Promise.all(response.devices.map(async (device) => {
      const trust = await cryptoApi?.getDeviceVerificationStatus(this.session.userId, device.device_id).catch(() => null);
      return {
        deviceId: device.device_id,
        displayName: device.display_name || "Unnamed device",
        lastSeenTs: device.last_seen_ts,
        lastSeenIp: device.last_seen_ip,
        current: device.device_id === this.session.deviceId,
        verified: trust?.isVerified() ?? false,
      };
    }));
  }

  async getCryptoStatus() {
    const cryptoApi = this.requireClient().getCrypto();
    if (!cryptoApi) return { secretStorageReady: false, crossSigningReady: false, backupVersion: null };
    const [secretStatus, crossSigning, backupVersion] = await Promise.all([
      cryptoApi.getSecretStorageStatus(),
      cryptoApi.getCrossSigningStatus(),
      cryptoApi.getActiveSessionBackupVersion(),
    ]);
    return {
      secretStorageReady: secretStatus.ready,
      crossSigningReady: crossSigning.publicKeysOnDevice && (
        crossSigning.privateKeysInSecretStorage
        || Object.values(crossSigning.privateKeysCachedLocally).every(Boolean)
      ),
      backupVersion,
    };
  }

  async setupRecovery(passphrase?: string): Promise<string> {
    const cryptoApi = this.requireClient().getCrypto();
    if (!cryptoApi) throw new Error("Encryption is not available on this device.");
    const generated = await cryptoApi.createRecoveryKeyFromPassphrase(passphrase?.trim() || undefined);
    await cryptoApi.bootstrapSecretStorage({
      createSecretStorageKey: async () => generated,
      setupNewKeyBackup: true,
    });
    return generated.encodedPrivateKey ?? "Recovery storage was configured with the supplied passphrase.";
  }

  async unlockRecovery(secret: string): Promise<void> {
    const cryptoApi = this.requireClient().getCrypto();
    if (!cryptoApi) throw new Error("Encryption is not available on this device.");
    const status = await cryptoApi.getSecretStorageStatus();
    if (!status.defaultKeyId) throw new Error("This account does not have a recovery key configured.");
    const keyInfo = status.secretStorageKeyValidityMap;
    const keyTuple = await this.requireClient().secretStorage.getKey(status.defaultKeyId);
    const keyDescription = keyTuple?.[1];
    let key: Uint8Array<ArrayBuffer>;
    if (keyDescription?.passphrase) {
      key = await deriveRecoveryKeyFromPassphrase(
        secret,
        keyDescription.passphrase.salt,
        keyDescription.passphrase.iterations,
        keyDescription.passphrase.bits,
      );
    } else {
      key = decodeRecoveryKey(secret);
    }
    void keyInfo;
    this.secretStorageKey = [status.defaultKeyId, key];
    await cryptoApi.loadSessionBackupPrivateKeyFromSecretStorage();
    await cryptoApi.checkKeyBackupAndEnable();
  }

  async startDeviceVerification(deviceId?: string): Promise<void> {
    const cryptoApi = this.requireClient().getCrypto();
    if (!cryptoApi) throw new Error("Encryption is not available on this device.");
    if (this.activeVerification?.request.pending) {
      throw new Error("A device verification is already in progress.");
    }
    const request = deviceId
      ? await cryptoApi.requestDeviceVerification(this.session.userId, deviceId)
      : await cryptoApi.requestOwnUserVerification();
    const direction = request.initiatedByMe ? "outgoing" : "incoming";
    const context = this.bindVerification(request, direction);
    this.emit({
      verification: this.verificationState(context, direction === "incoming" ? "incoming" : "waiting", {
        message: direction === "incoming"
          ? "Another Sub-Etha receiver wants to verify this device."
          : "Open Sub-Etha on your other device and accept the verification request.",
      }),
    });
    this.handleVerificationChange(request);
  }

  async acceptDeviceVerification(): Promise<void> {
    const context = this.activeVerification;
    if (!context || context.direction !== "incoming") throw new Error("There is no incoming verification request.");
    this.emit({
      verification: this.verificationState(context, "waiting", {
        message: "Request accepted. Waiting for your other Sub-Etha receiver to begin the comparison.",
      }),
    });
    await context.request.accept();
    this.handleVerificationChange(context.request);
  }

  async confirmDeviceVerification(matches: boolean): Promise<void> {
    const context = this.activeVerification;
    const callbacks = context?.sasCallbacks;
    if (!context || !callbacks) throw new Error("The emoji comparison is not ready yet.");
    context.sasCallbacks = null;
    if (!matches) {
      callbacks.mismatch();
      this.finishVerification("cancelled", "The emoji did not match, so verification was safely cancelled.");
      return;
    }
    this.emit({
      verification: this.verificationState(context, "waiting", {
        message: "Match confirmed here. Waiting for your other device to confirm as well.",
      }),
    });
    await callbacks.confirm();
  }

  async cancelDeviceVerification(): Promise<void> {
    const context = this.activeVerification;
    if (!context) {
      this.emit({ verification: null });
      return;
    }
    try {
      if (context.sasCallbacks) context.sasCallbacks.cancel();
      else await context.request.cancel();
    } finally {
      if (this.activeVerification === context) this.finishVerification("cancelled", "Verification cancelled.");
    }
  }

  dismissDeviceVerification(): void {
    if (!this.activeVerification) this.emit({ verification: null });
  }

  getClient(): MatrixClient {
    return this.requireClient();
  }

  async removePusher(pushKey: string): Promise<void> {
    const request: IPusherRequest = {
      app_display_name: "Sub-Etha",
      app_id: "chat.subetha.pwa",
      device_display_name: "Sub-Etha PWA",
      kind: null as never,
      lang: navigator.language || "en",
      pushkey: pushKey,
      data: {},
    };
    await this.requireClient().setPusher(request);
  }

  async logout(): Promise<void> {
    this.stopped = true;
    try { await this.client?.logout(); } catch { /* local cleanup still proceeds */ }
    this.client?.stopClient();
    this.client?.off(CryptoEvent.VerificationRequestReceived, this.handleIncomingVerification);
    window.removeEventListener("storage", this.handleTakeoverRequest);
    try {
      await this.client?.clearStores({ cryptoDatabasePrefix: `sub-etha-crypto-${stableStoreName(this.session)}` });
    } catch { /* best effort */ }
    await clearSession();
    this.releaseMediaAssets();
    this.releaseVerificationContext();
    this.releaseLock?.();
    this.releaseLock = null;
    this.emit({ connection: "idle", rooms: [], timeline: [], activeRoomId: null });
  }

  stop(): void {
    this.stopped = true;
    this.client?.stopClient();
    this.client?.off(CryptoEvent.VerificationRequestReceived, this.handleIncomingVerification);
    window.removeEventListener("storage", this.handleTakeoverRequest);
    this.releaseMediaAssets();
    this.releaseVerificationContext();
    this.releaseLock?.();
    this.releaseLock = null;
  }

  private releaseMediaAssets(): void {
    for (const promise of this.mediaAssets.values()) {
      void promise.then((asset) => URL.revokeObjectURL(asset.url)).catch(() => undefined);
    }
    for (const promise of this.gifPosters.values()) {
      void promise.then((url) => { if (url) URL.revokeObjectURL(url); }).catch(() => undefined);
    }
    this.mediaAssets.clear();
    this.gifPosters.clear();
  }
}
