import type { MatrixEvent, Room } from "matrix-js-sdk";
import type { ValidatedAuthMetadata } from "matrix-js-sdk/lib/oauth";

export type AuthKind = "password" | "sso" | "token" | "oauth";

export interface PersistedMatrixSession {
    baseUrl: string;
    userId: string;
    deviceId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    authKind: AuthKind;
    cryptoStorageKey: string;
    oauth?: {
        clientId: string;
        deviceId: string;
        redirectUri: string;
        metadata: ValidatedAuthMetadata;
    };
}

export interface LoginCapabilities {
    baseUrl: string;
    serverName: string;
    password: boolean;
    token: boolean;
    sso: boolean;
    oauth: boolean;
    identityProviders: Array<{ id: string; name: string; brand?: string }>;
}

export interface RoomSummary {
    id: string;
    name: string;
    guideCode?: string;
    topic?: string | null;
    classification?: string;
    avatarMxcUrl: string | null;
    membership: string;
    lastMessage: string;
    timestamp: number;
    unread: number;
    highlights: number;
    encrypted: boolean;
    favourite: boolean;
    muted: boolean;
    memberCount: number;
    room: Room;
}

export interface ReactionSummary {
    key: string;
    count: number;
    mine: boolean;
    ownEventId?: string;
}

export interface MatrixMediaRef {
    mxcUrl: string;
    mimeType?: string;
    size?: number;
    width?: number;
    height?: number;
    encryptedFile?: Record<string, unknown>;
}

export interface MediaAsset {
    url: string;
    blob: Blob;
    mimeType: string;
    animated: boolean;
}

export interface TimelineItem {
    id: string;
    type: "message" | "image" | "video" | "audio" | "file" | "notice" | "system" | "encrypted";
    senderId: string;
    senderName: string;
    senderAvatarMxcUrl: string | null;
    body: string;
    formattedBody?: string;
    timestamp: number;
    own: boolean;
    edited: boolean;
    redacted: boolean;
    encrypted: boolean;
    decryptionState: "ready" | "decrypting" | "failed";
    media?: MatrixMediaRef;
    replyTo?: string;
    replySummary?: {
        senderName: string;
        body: string;
    };
    reactions: ReactionSummary[];
    sendingStatus: string | null;
    readBy: string[];
    event: MatrixEvent;
}

export type ConnectionState = "idle" | "starting" | "ready" | "catching-up" | "offline" | "error";

export type DeviceVerificationStage =
    "incoming" | "waiting" | "comparing" | "complete" | "cancelled" | "error";

export interface DeviceVerificationState {
    transactionId: string | null;
    direction: "incoming" | "outgoing";
    otherUserId: string;
    otherDeviceId: string | null;
    stage: DeviceVerificationStage;
    emojis: Array<[emoji: string, name: string]>;
    decimals?: [number, number, number];
    message?: string;
}

export interface MatrixSnapshot {
    connection: ConnectionState;
    rooms: RoomSummary[];
    activeRoomId: string | null;
    timeline: TimelineItem[];
    timelineStartIndex: number;
    typingNames: string[];
    loadingHistory: boolean;
    hasMoreHistory: boolean;
    error: string | null;
    userId: string;
    displayName: string;
    avatarMxcUrl: string | null;
    deviceId: string;
    verification: DeviceVerificationState | null;
}

export interface PushState {
    supported: boolean;
    enabled: boolean;
    permission: NotificationPermission | "unsupported";
    checking?: boolean;
    error?: string;
}

export interface DeviceSummary {
    deviceId: string;
    displayName: string;
    lastSeenTs?: number;
    lastSeenIp?: string;
    current: boolean;
    verified: boolean;
}
