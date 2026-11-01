import { AwsClient } from "aws4fetch";

export default {
    async fetch(request, env) {
        if (!["GET", "HEAD"].includes(request.method)) {
            return new Response("Method Not Allowed", {
                status: 405
            });
        }

        try {
            const incomingUrl = new URL(request.url);

            // Only serve files, not arbitrary query-string variants
            if (incomingUrl.search) {
                return new Response("Query strings not supported", {
                    status: 400
                });
            }

            const filePath = incomingUrl.pathname.replace(/^\/+/, "");

            if (!filePath) {
                return new Response("B2 Proxy Active", {
                    headers: {
                        "Cache-Control": "no-store"
                    }
                });
            }

            // Basic abuse protection
            // Only reached on cache misses when Workers Caching is enabled.
            if (env.VIDEO_LIMITER) {
                const ip = request.headers.get("CF-Connecting-IP") || "unknown";

                const { success } = await env.VIDEO_LIMITER.limit({
                    key: ip
                });

                if (!success) {
                    return new Response("Too Many Requests", {
                        status: 429,
                        headers: {
                            "Retry-After": "60",
                            "Cache-Control": "no-store"
                        }
                    });
                }
            }

            // Backblaze configuration
            const endpoint = String(env.B2_ENDPOINT || "")
                .trim()
                .replace(/^https?:\/\//i, "")
                .replace(/\/+$/, "");

            const bucket = String(env.BUCKET_NAME || "").trim();

            const region = String(env.B2_REGION || "");

            if (
                !endpoint ||
                !bucket ||
                !env.B2_APPLICATION_KEY_ID ||
                !env.B2_APPLICATION_KEY
            ) {
                throw new Error("Missing B2 configuration");
            }

            // Construct upstream URL
            const host = `${bucket}.${endpoint}`;

            const upstreamUrl = new URL(
                incomingUrl.pathname,
                `https://${host}`
            );

            // AWS Signature V4
            const client = new AwsClient({
                accessKeyId: env.B2_APPLICATION_KEY_ID,
                secretAccessKey: env.B2_APPLICATION_KEY,
                service: "s3",
                region
            });

            const signedRequest = await client.sign(
                upstreamUrl.toString(),
                {
                    method: request.method
                }
            );

            // IMPORTANT:
            // Do not forward Range headers.
            // Workers Caching strips incoming Range headers,
            // caches the complete 200 response, and handles
            // partial responses automatically.

            const b2Response = await fetch(signedRequest);

            if (!b2Response.ok) {
                const errorBody = await b2Response.text();

                console.error(
                    "Backblaze error:",
                    b2Response.status,
                    errorBody
                );

                return new Response(errorBody, {
                    status: b2Response.status,
                    headers: {
                        "Content-Type":
                            b2Response.headers.get("Content-Type") ||
                            "application/xml",
                        "Cache-Control": "no-store"
                    }
                });
            }

            const responseHeaders = new Headers(b2Response.headers);

            // Browser cache: 1 hour
            // Cloudflare cache: 24 hours
            responseHeaders.set(
                "Cache-Control",
                "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600"
            );

            // HEAD requests must not populate the cache with
            // a bodyless response.
            if (request.method === "HEAD") {
                responseHeaders.set("Cache-Control", "no-store");
            }

            return new Response(
                request.method === "HEAD" ? null : b2Response.body,
                {
                    status: b2Response.status,
                    headers: responseHeaders
                }
            );

        } catch (error) {
            console.error(
                "Worker exception:",
                error.stack || error
            );

            return new Response("Internal Worker Error", {
                status: 500
            });
        }
    }
};
