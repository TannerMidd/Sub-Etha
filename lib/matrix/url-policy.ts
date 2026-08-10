export interface HomeserverUrlPolicy {
    appOrigin?: string;
    production?: boolean;
}

export class InsecureHomeserverError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InsecureHomeserverError";
    }
}

function runtimeAppOrigin(): string | undefined {
    return typeof window === "undefined" ? undefined : window.location.origin;
}

function runtimeProduction(): boolean {
    return typeof process !== "undefined" && process.env.NODE_ENV === "production";
}

export function isLoopbackHostname(raw: string): boolean {
    const hostname = raw.toLowerCase().replace(/^\[|\]$/g, "");

    if (hostname === "localhost" || hostname === "::1") {
        return true;
    }

    const octets = hostname.split(".");

    return (
        octets.length === 4 &&
        octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
        Number(octets[0]) === 127
    );
}

export function assertAllowedHomeserverUrl(raw: string, policy: HomeserverUrlPolicy = {}): string {
    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        throw new InsecureHomeserverError("The homeserver address is not a valid URL.");
    }

    if (url.username || url.password) {
        throw new InsecureHomeserverError("Homeserver URLs may not contain embedded credentials.");
    }

    if (url.search || url.hash) {
        throw new InsecureHomeserverError("Homeserver URLs may not contain a query or fragment.");
    }

    if (url.protocol === "https:") {
        return url.href.replace(/\/$/, "");
    }

    if (url.protocol !== "http:") {
        throw new InsecureHomeserverError("Matrix homeservers must use HTTPS.");
    }

    const production = policy.production ?? runtimeProduction();
    const appOrigin = policy.appOrigin ?? runtimeAppOrigin();
    let appUrl: URL | null = null;

    try {
        appUrl = appOrigin ? new URL(appOrigin) : null;
    } catch {
        appUrl = null;
    }

    if (
        production ||
        !appUrl ||
        !isLoopbackHostname(appUrl.hostname) ||
        !isLoopbackHostname(url.hostname)
    ) {
        throw new InsecureHomeserverError(
            "Matrix homeservers must use HTTPS outside loopback development.",
        );
    }

    return url.href.replace(/\/$/, "");
}
