import type { NextConfig } from "next";

const securityHeaders = [
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Origin-Agent-Cluster", value: "?1" },
    {
        key: "Permissions-Policy",
        value: [
            "accelerometer=()",
            "camera=()",
            "display-capture=()",
            "geolocation=()",
            "gyroscope=()",
            "magnetometer=()",
            "microphone=()",
            "payment=()",
            "publickey-credentials-create=()",
            "usb=()",
        ].join(", "),
    },
];

const nextConfig: NextConfig = {
    async headers() {
        return [
            {
                source: "/(.*)",
                headers: securityHeaders,
            },
        ];
    },
};

export default nextConfig;
