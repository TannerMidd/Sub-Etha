import clsx, { type ClassValue } from "clsx";

let styles: Record<string, string> = {};

export function configureStyles(nextStyles: Record<string, string>): void {
    styles = nextStyles;
}

export function classes(...values: ClassValue[]): string {
    return clsx(values)
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => styles[name] ?? name)
        .join(" ");
}
