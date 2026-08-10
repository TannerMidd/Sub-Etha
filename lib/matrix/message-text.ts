export interface MessageTextSegment {
    text: string;
    href?: string;
}

const LINK_PATTERN =
    /(?:(?:https?|ftp):\/\/|www\.|magnet:\?)[^\s<>"']+|mailto:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SIMPLE_TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", "…"]);
const CLOSING_PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function splitTrailingPunctuation(value: string): [link: string, suffix: string] {
    let end = value.length;

    while (end > 0) {
        const last = value[end - 1];

        if (SIMPLE_TRAILING_PUNCTUATION.has(last)) {
            end -= 1;
            continue;
        }

        const opening = CLOSING_PAIRS[last];

        if (!opening) {
            break;
        }

        const candidate = value.slice(0, end);
        const openingCount = [...candidate].filter((character) => character === opening).length;
        const closingCount = [...candidate].filter((character) => character === last).length;

        if (closingCount <= openingCount) {
            break;
        }

        end -= 1;
    }

    return [value.slice(0, end), value.slice(end)];
}

function hrefFor(value: string): string {
    if (value.toLowerCase().startsWith("www.")) {
        return `https://${value}`;
    }

    if (/^(?:mailto|magnet):/i.test(value)) {
        return value;
    }

    if (!value.includes("://")) {
        return `mailto:${value}`;
    }

    return value;
}

function pushText(segments: MessageTextSegment[], text: string): void {
    if (!text) {
        return;
    }

    const previous = segments.at(-1);

    if (previous && !previous.href) {
        previous.text += text;
    } else {
        segments.push({ text });
    }
}

export function messageTextSegments(value: string): MessageTextSegment[] {
    const segments: MessageTextSegment[] = [];
    let cursor = 0;

    for (const match of value.matchAll(LINK_PATTERN)) {
        const index = match.index;

        if (index > cursor) {
            pushText(segments, value.slice(cursor, index));
        }

        const [link, suffix] = splitTrailingPunctuation(match[0]);

        if (link) {
            segments.push({ text: link, href: hrefFor(link) });
        }

        pushText(segments, suffix);
        cursor = index + match[0].length;
    }

    if (cursor < value.length) {
        pushText(segments, value.slice(cursor));
    }

    return segments;
}

export function stripPlainReplyFallback(value: string): string {
    const lines = value.split("\n");
    let firstContentLine = 0;

    while (firstContentLine < lines.length && lines[firstContentLine].startsWith("> ")) {
        firstContentLine += 1;
    }

    if (firstContentLine === 0) {
        return value;
    }

    if (lines[firstContentLine] === "") {
        firstContentLine += 1;
    }

    return lines.slice(firstContentLine).join("\n");
}
