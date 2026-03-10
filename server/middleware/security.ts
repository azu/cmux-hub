/**
 * Security middleware for local server.
 * Ref: https://green.sapphi.red/blog/local-server-security-best-practices
 */

type SecurityConfig = {
  port: number;
  allowedHosts?: string[];
};

/**
 * Validate the Host header to prevent DNS rebinding attacks.
 */
export function isValidHost(hostHeader: string | null, config: SecurityConfig): boolean {
  if (!hostHeader) return false;

  const allowed = config.allowedHosts ?? [
    `localhost:${config.port}`,
    `127.0.0.1:${config.port}`,
    `[::1]:${config.port}`,
    // Without port (some browsers omit default ports)
    "localhost",
    "127.0.0.1",
    "[::1]",
  ];

  return allowed.includes(hostHeader);
}

/**
 * Validate the Origin header for CORS and CSWSH protection.
 */
export function isValidOrigin(origin: string | null, _config: SecurityConfig): boolean {
  if (!origin) return true; // same-origin GET requests may not include Origin
  // Allow any localhost origin (preview pages on different ports need to reach cmux-hub)
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Check Sec-Fetch-Site for write operations (CSRF protection).
 * Only allows same-origin requests for state-changing methods.
 */
export function isValidSecFetchSite(secFetchSite: string | null, method: string, origin?: string | null): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return true;

  // If the header is missing, we can't verify - allow for non-browser clients
  if (!secFetchSite) return true;

  if (secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none") return true;

  // Allow cross-site requests from localhost origins (preview pages on different ports)
  if (secFetchSite === "cross-site" && origin) {
    try {
      const url = new URL(origin);
      return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Build security headers for responses.
 */
export function securityHeaders(): Record<string, string> {
  return {
    "Cross-Origin-Resource-Policy": "same-site",
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * Validate an incoming request against all security checks.
 * Returns null if valid, or a Response with error if invalid.
 */
export function validateRequest(req: Request, config: SecurityConfig): Response | null {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  const secFetchSite = req.headers.get("sec-fetch-site");

  // Build CORS headers for error responses so browsers can read the error
  const errorHeaders = corsHeaders(config, origin);

  // Host header validation (DNS rebinding)
  if (!isValidHost(host, config)) {
    return new Response("Forbidden: invalid host", { status: 403, headers: errorHeaders });
  }

  // Origin validation (CORS/CSRF)
  // Reject null origin on write requests (blocks file:// and sandboxed iframe attacks)
  if (!origin && WRITE_METHODS.has(req.method.toUpperCase()) && secFetchSite) {
    return new Response("Forbidden: missing origin", { status: 403, headers: errorHeaders });
  }
  if (!isValidOrigin(origin, config)) {
    return new Response("Forbidden: invalid origin", { status: 403, headers: errorHeaders });
  }

  // Sec-Fetch-Site validation (CSRF for write operations)
  // Skip for validated localhost origins — Origin check already prevents external access
  if (!isValidSecFetchSite(secFetchSite, req.method, origin)) {
    if (!origin || !isValidOrigin(origin, config)) {
      return new Response("Forbidden: cross-origin write", { status: 403, headers: errorHeaders });
    }
  }

  return null;
}

/**
 * Build CORS headers for preflight and regular responses.
 */
export function corsHeaders(config: SecurityConfig, requestOrigin?: string | null): Record<string, string> {
  // If the request comes from a valid localhost origin, reflect it back
  let allowOrigin = `http://localhost:${config.port}`;
  if (requestOrigin) {
    try {
      const url = new URL(requestOrigin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
        allowOrigin = requestOrigin;
      }
    } catch {
      // use default
    }
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * Validate WebSocket upgrade request origin.
 */
export function isValidWebSocketOrigin(req: Request, config: SecurityConfig): boolean {
  const origin = req.headers.get("origin");
  return isValidOrigin(origin, config);
}
