import DOMPurify from "dompurify";
import type { Config } from "dompurify";
import type { TrustedHTML, TrustedTypePolicyFactory } from "trusted-types/lib/index.js";

const TRUSTED_HTML_POLICY_NAME = "subetha-matrix-html";
const ALLOWED_TAGS = [
    "a",
    "b",
    "blockquote",
    "br",
    "caption",
    "code",
    "del",
    "details",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
];
const RICH_REPLY_FALLBACK = /^\s*<mx-reply(?:\s[^>]*)?>[\s\S]*?<\/mx-reply>\s*/i;
const MATRIX_HTML_SANITIZER_CONFIG = {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [
        "href",
        "title",
        "start",
        "data-mx-color",
        "data-mx-bg-color",
        "data-mx-spoiler",
        "data-mx-maths",
    ],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|mailto|magnet):)/i,
    RETURN_TRUSTED_TYPE: false,
    TRUSTED_TYPES_POLICY: null,
} satisfies Config;

interface HtmlPolicy {
    readonly name: string;
    createHTML(input: string): TrustedHTML;
}

let cachedPolicy: HtmlPolicy | undefined;
let failedPolicyFactory: TrustedTypePolicyFactory | undefined;

function sanitizeToString(value: string): string {
    if (typeof document === "undefined" || typeof DOMPurify.sanitize !== "function") {
        return "";
    }

    try {
        return DOMPurify.sanitize(
            value.replace(RICH_REPLY_FALLBACK, ""),
            MATRIX_HTML_SANITIZER_CONFIG,
        );
    } catch {
        return "";
    }
}

function getPolicy(): HtmlPolicy | undefined {
    if (cachedPolicy) {
        return cachedPolicy;
    }

    if (typeof document === "undefined") {
        return undefined;
    }

    const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypePolicyFactory })
        .trustedTypes;

    if (!factory || typeof factory.createPolicy !== "function" || factory === failedPolicyFactory) {
        return undefined;
    }

    try {
        cachedPolicy = factory.createPolicy(TRUSTED_HTML_POLICY_NAME, {
            createHTML: sanitizeToString,
        });
    } catch {
        failedPolicyFactory = factory;
    }

    return cachedPolicy;
}

export function sanitizeMatrixHtml(value: string): string | TrustedHTML {
    const policy = getPolicy();

    if (policy) {
        try {
            return policy.createHTML(value);
        } catch {
            // A policy failure must never turn the unsanitized input into a fallback value.
        }
    }

    return sanitizeToString(value);
}
