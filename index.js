import { AwsClient } from "aws4fetch";

export default {
    async fetch(request, env) {
        if (!["GET", "HEAD"].includes(request.method)) {
            return new Response("Method Not Allowed", {
                status: 405
            });
        }

        try {
            // Configuration
            const endpoint = env.B2_ENDPOINT;
            const bucket = env.BUCKET_NAME;
            const region = env.B2_REGION;

            if (!endpoint || !bucket || !region ||
                !env.B2_APPLICATION_KEY_ID ||
                !env.B2_APPLICATION_KEY) {
                return new Response("Missing Worker configuration", {
                    status: 500
                });
            }

            // Get requested file path
            const incomingUrl = new URL(request.url);
            const filePath = incomingUrl.pathname.replace(/^\/+/, "");

            if (!filePath) {
                return new Response("B2 Proxy Active", {
                    status: 200
                });
            }

            // Construct Backblaze URL using path-style addressing
            const upstreamUrl = new URL(
                `https://${endpoint}/${bucket}/${filePath}`
            );

            // Preserve query parameters
            upstreamUrl.search = incomingUrl.search;

            // Forward Range requests (important for video playback)
            const headers = new Headers();

            const range = request.headers.get("Range");
            if (range) {
                headers.set("Range", range);
            }

            // AWS Signature V4
            const client = new AwsClient({
                accessKeyId: env.B2_APPLICATION_KEY_ID,
                secretAccessKey: env.B2_APPLICATION_KEY,
                service: "s3",
                region: region
            });

            const signedRequest = await client.sign(
                upstreamUrl.toString(),
                {
                    method: request.method,
                    headers
                }
            );

            // Fetch from Backblaze
            const response = await fetch(signedRequest);

            // Return Backblaze errors unchanged for debugging
            if (!response.ok) {
                const errorBody = await response.text();

                console.error(
                    "Backblaze error:",
                    response.status,
                    errorBody
                );

                return new Response(errorBody, {
                    status: response.status,
                    headers: {
                        "Content-Type": "application/xml"
                    }
                });
            }

            // Return response, preserving video/range headers
            const responseHeaders = new Headers(response.headers);

            // Don't make private files publicly cacheable by default
            responseHeaders.set("Cache-Control", "private, no-store");

            return new Response(
                request.method === "HEAD" ? null : response.body,
                {
                    status: response.status,
                    statusText: response.statusText,
                    headers: responseHeaders
                }
            );

        } catch (error) {
            console.error("Worker exception:", error.stack || error);

            return new Response(
                "Worker Error: " + error.message,
                { status: 500 }
            );
        }
    }
};
