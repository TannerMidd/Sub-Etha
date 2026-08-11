import type { Metadata } from "next";
import { headers } from "next/headers";
import "./styles/globals.scss";

export async function generateMetadata(): Promise<Metadata> {
    const requestHeaders = await headers();
    const host =
        requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
    const protocol =
        requestHeaders.get("x-forwarded-proto") ??
        (host.startsWith("localhost") ? "http" : "https");

    return {
        metadataBase: new URL(`${protocol}://${host}`),
        title: { default: "Sub-Etha", template: "%s · Sub-Etha" },
        description: "A fast, private, installable Matrix client for the rest of the galaxy.",
        applicationName: "Sub-Etha",
        manifest: "/manifest.webmanifest",
        appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Sub-Etha" },
        formatDetection: { telephone: false },
        openGraph: {
            type: "website",
            title: "Sub-Etha",
            description: "Matrix chat, minus the unnecessary improbability.",
            images: [
                {
                    url: "/og.png",
                    width: 1200,
                    height: 630,
                    alt: "Sub-Etha orbital signal mark",
                },
            ],
        },
        twitter: {
            card: "summary_large_image",
            title: "Sub-Etha",
            description: "Matrix chat, minus the unnecessary improbability.",
            images: ["/og.png"],
        },
        icons: {
            icon: [
                { url: "/favicon.ico" },
                { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
                { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
            ],
            apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
        },
    };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body>{children}</body>
        </html>
    );
}
