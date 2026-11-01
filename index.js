import { AwsClient } from "aws4fetch";

export default {
    async fetch(request, env) {
        if (!["GET", "HEAD"].includes(request.method)) {
            return new Response("Method Not Allowed", { status: 405 });
        }

        try {
            const endpoint = String(env.B2_ENDPOINT || "")
                .replace(/^https?:\/\//i, "")
                .replace(/\/+$/, "");

            const bucket = String(env.BUCKET_NAME || "").trim();

            const region = "us-east-005";

            if (!endpoint || !bucket ||
                !env.B2_APPLICATION_KEY_ID ||
                !env.B2_APPLICATION_KEY) {
                throw new Error("Missing environment variables");
            }

            // Build bucket hostname
            const host = `${bucket}.${endpoint}`;

            // Read requested filename
            const incomingUrl = new URL(request.url);
            const filePath = incomingUrl.pathname.replace(/^\/+/, "");

            if (!filePath) {
                return new Response("B2 Proxy Active", { status: 200 });
            }

            // Encode filename while preserving folder separators
            const encodedPath = filePath
                .split("/")
                .map(segment => encodeURIComponent(segment))
                .join("/");

            // Build Backblaze URL
            const target = `https://${host}/${encodedPath}`;

            console.log("Incoming URL:", request.url);
            console.log("Endpoint:", endpoint);
            console.log("Bucket:", bucket);
            console.log("Host:", host);
            console.log("File path:", filePath);
            console.log("Encoded path:", encodedPath);
            console.log("Target URL:", target);
            
            let upstreamUrl;
            
            try {
                upstreamUrl = new URL(target);
            } catch (e) {
                throw new Error(
                    "URL construction failed: " + target + " | " + e.message
                );
            }

            upstreamUrl.search = incomingUrl.search;

            // Forward Range header for video playback
            const headers = new Headers();

            const range = request.headers.get("Range");
            if (range) {
                headers.set("Range", range);
            }

            // Sign request
            const client = new AwsClient({
                accessKeyId: env.B2_APPLICATION_KEY_ID,
                secretAccessKey: env.B2_APPLICATION_KEY,
                service: "s3",
                region
            });

            const signedRequest = await client.sign(
                upstreamUrl.toString(),
                {
                    method: request.method,
                    headers
                }
            );

            // Fetch file
            const response = await fetch(signedRequest);

            if (!response.ok) {
                const body = await response.text();

                console.error("B2 response:", response.status, body);

                return new Response(body, {
                    status: response.status,
                    headers: {
                        "Content-Type": "application/xml"
                    }
                });
            }

            const responseHeaders = new Headers(response.headers);
            responseHeaders.set("Cache-Control", "private, no-store");

            return new Response(
                request.method === "HEAD" ? null : response.body,
                {
                    status: response.status,
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
