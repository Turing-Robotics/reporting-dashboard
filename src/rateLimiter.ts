/**
 * Rate Limiting module for Turing VR Backend
 *
 * Provides rate limiting middleware for REST API endpoints and Socket.IO events
 * to prevent abuse and DDoS attacks.
 *
 * Features:
 * - Express middleware rate limiters for REST endpoints
 * - Manual Socket.IO event rate limiting with per-event configuration
 * - Automatic cleanup of expired rate limit entries
 * - Development mode with relaxed limits for testing
 *
 * @module rateLimiter
 */

import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'
import { Request, Response } from 'express'
import { socketLogger } from './logger'

// =============================================================================
// TYPES
// =============================================================================

// Extend Express Request to include rateLimit property added by express-rate-limit
declare module 'express-serve-static-core' {
    interface Request {
        rateLimit?: {
            limit: number
            current: number
            remaining: number
            resetTime?: Date
        }
    }
}

/**
 * Configuration for a single Socket.IO event rate limit.
 */
interface SocketRateLimitConfig {
    /** Time window in milliseconds */
    window: number
    /** Maximum allowed events within the window */
    max: number
}

/**
 * Tracks rate limit state for a single event type.
 */
interface RateLimitEntry {
    /** Number of events recorded in current window */
    count: number
    /** Timestamp when the current window expires */
    resetTime: number
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Whether the application is running in development mode */
const isDevelopment: boolean = process.env.NODE_ENV !== 'production'

/** Multiplier for rate limits in development mode (more lenient for testing) */
const DEV_MULTIPLIER: number = isDevelopment ? 10 : 1

// =============================================================================
// RATE LIMITERS
// =============================================================================

/**
 * General API rate limiter for standard REST endpoints.
 *
 * Configuration:
 * - Window: 1 minute
 * - Max requests: 100 per IP (1000 in development)
 * - Returns standard rate limit headers
 *
 * Use this for general API endpoints that don't have specific rate limit needs.
 *
 * @example
 * ```typescript
 * app.use('/api/', apiLimiter)
 * ```
 */
export const apiLimiter: RateLimitRequestHandler = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100 * DEV_MULTIPLIER, // 100 requests per minute per IP
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    message: {
        ok: false,
        error: 'Too many requests. Please wait before making additional requests. Rate limit: 100 requests per minute.',
        retryAfter: 60
    },
    handler: (req: Request, res: Response): void => {
        const retryAfterSeconds: number = Math.ceil(
            (req.rateLimit?.resetTime?.getTime() || Date.now() + 60000 - Date.now()) / 1000
        )
        res.status(429).json({
            ok: false,
            error: 'Too many requests. Please wait before making additional requests. Rate limit: 100 requests per minute.',
            retryAfter: retryAfterSeconds
        })
    }
})

/**
 * Rate limiter for file upload endpoints.
 *
 * Configuration:
 * - Window: 15 minutes
 * - Max requests: 10 per IP (100 in development)
 * - Stricter than general API due to resource intensity
 *
 * Use this for upload endpoints to prevent storage abuse.
 *
 * @example
 * ```typescript
 * app.post('/upload-session', uploadLimiter, uploadHandler)
 * ```
 */
export const uploadLimiter: RateLimitRequestHandler = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10 * DEV_MULTIPLIER, // 10 uploads per 15 minutes
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        error: 'Upload rate limit exceeded. Maximum 10 uploads per 15 minutes. Please wait before uploading again.',
        retryAfter: 900
    },
    handler: (req: Request, res: Response): void => {
        const retryAfterSeconds: number = Math.ceil(
            (req.rateLimit?.resetTime?.getTime() || Date.now() + 900000 - Date.now()) / 1000
        )
        res.status(429).json({
            ok: false,
            error: 'Upload rate limit exceeded. Maximum 10 uploads per 15 minutes. Please wait before uploading again.',
            retryAfter: retryAfterSeconds
        })
    }
})

/**
 * Rate limiter for authentication endpoints.
 *
 * Configuration:
 * - Window: 1 minute
 * - Max requests: 20 per IP (200 in development)
 * - Stricter to prevent brute force attacks
 *
 * Use this for login, token generation, and other auth endpoints.
 *
 * @example
 * ```typescript
 * app.use('/auth', authLimiter, createAuthRouter())
 * ```
 */
export const authLimiter: RateLimitRequestHandler = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20 * DEV_MULTIPLIER, // 20 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        error: 'Too many authentication attempts. Maximum 20 attempts per minute. Please wait before trying again.',
        retryAfter: 60
    }
})

/**
 * Rate limiter for Prometheus metrics endpoint.
 *
 * Configuration:
 * - Window: 1 minute
 * - Max requests: 30 per IP (300 in development)
 * - Tuned for typical Prometheus scrape intervals (15-30 seconds)
 *
 * @example
 * ```typescript
 * app.get('/metrics', metricsLimiter, metricsHandler)
 * ```
 */
export const metricsLimiter: RateLimitRequestHandler = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30 * DEV_MULTIPLIER, // 30 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        error: 'Metrics rate limit exceeded. Maximum 30 requests per minute.',
        retryAfter: 60
    }
})

/**
 * Rate limiter for health check endpoints.
 *
 * Configuration:
 * - Window: 1 minute
 * - Max requests: 60 per IP (600 in development)
 * - Lenient to support frequent load balancer health checks
 *
 * @example
 * ```typescript
 * app.get('/health', healthLimiter, healthHandler)
 * ```
 */
export const healthLimiter: RateLimitRequestHandler = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60 * DEV_MULTIPLIER, // 60 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        error: 'Health check rate limit exceeded. Maximum 60 requests per minute.',
        retryAfter: 60
    }
})

// =============================================================================
// SOCKET.IO RATE LIMITING (manual implementation)
// =============================================================================

/**
 * In-memory storage for Socket.IO rate limit tracking.
 * Structure: socketId -> (eventName -> RateLimitEntry)
 */
const socketRateLimits: Map<string, Map<string, RateLimitEntry>> = new Map()

/**
 * Rate limit configuration per Socket.IO event type.
 *
 * Events are categorized by:
 * - Frequency: High-frequency events (frames, telemetry) have higher limits
 * - Cost: Database operations have lower limits to protect resources
 * - Criticality: Authentication events are tightly controlled
 *
 * All limits are multiplied by DEV_MULTIPLIER in development mode.
 */
const SOCKET_RATE_LIMITS: Record<string, SocketRateLimitConfig> = {
    // === HEADSET EVENTS (high frequency) ===
    'headset-frame': { window: 1000, max: 120 * DEV_MULTIPLIER }, // 120 frames/sec (allow burst)
    'headset-status': { window: 1000, max: 10 * DEV_MULTIPLIER }, // 10 status/sec
    'headset-identify': { window: 5000, max: 3 * DEV_MULTIPLIER }, // 3 identifies per 5 sec (prevent reconnect spam)
    'headset-recording-state': { window: 1000, max: 5 * DEV_MULTIPLIER }, // 5 state changes/sec

    // === TELEMETRY EVENTS ===
    'device-telemetry': { window: 1000, max: 5 * DEV_MULTIPLIER }, // 5 telemetry/sec

    // === TABLET LOCK/UNLOCK EVENTS (expensive - database operations) ===
    'tablet-lock-devices': { window: 5000, max: 5 * DEV_MULTIPLIER }, // 5 lock requests per 5 sec
    'tablet-lock-device': { window: 2000, max: 10 * DEV_MULTIPLIER }, // 10 single locks per 2 sec
    'tablet-unlock-device': { window: 2000, max: 10 * DEV_MULTIPLIER }, // 10 unlocks per 2 sec
    'tablet-unlock-all-devices': { window: 5000, max: 2 * DEV_MULTIPLIER }, // 2 unlock-all per 5 sec

    // === TABLET RECORDING EVENTS ===
    'tablet-toggle-recording': { window: 1000, max: 5 * DEV_MULTIPLIER }, // 5 toggles/sec
    'tablet-start-recording': { window: 1000, max: 5 * DEV_MULTIPLIER }, // 5 starts/sec
    'tablet-stop-recording': { window: 1000, max: 5 * DEV_MULTIPLIER }, // 5 stops/sec
    'tablet-start-all-recording': { window: 2000, max: 3 * DEV_MULTIPLIER }, // 3 start-all per 2 sec
    'tablet-stop-all-recording': { window: 2000, max: 3 * DEV_MULTIPLIER }, // 3 stop-all per 2 sec

    // === SESSION EVENTS (expensive - database operations) ===
    'tablet-create-session': { window: 5000, max: 3 * DEV_MULTIPLIER }, // 3 creates per 5 sec
    'tablet-start-session': { window: 2000, max: 5 * DEV_MULTIPLIER }, // 5 starts per 2 sec
    'tablet-pause-session': { window: 2000, max: 5 * DEV_MULTIPLIER }, // 5 pauses per 2 sec
    'tablet-end-session': { window: 2000, max: 5 * DEV_MULTIPLIER }, // 5 ends per 2 sec
    'tablet-get-session': { window: 1000, max: 10 * DEV_MULTIPLIER }, // 10 gets/sec
    'tablet-get-active-session': { window: 1000, max: 10 * DEV_MULTIPLIER }, // 10 gets/sec

    // === DASHBOARD EVENTS ===
    'dashboard-subscribe': { window: 5000, max: 5 * DEV_MULTIPLIER }, // 5 subscribes per 5 sec
    'dashboard-unsubscribe': { window: 5000, max: 5 * DEV_MULTIPLIER }, // 5 unsubscribes per 5 sec

    // === LEGACY TABLET EVENTS ===
    'tablet-connect-headset': { window: 2000, max: 10 * DEV_MULTIPLIER }, // 10 connects per 2 sec
    'tablet-disconnect-headset': { window: 2000, max: 10 * DEV_MULTIPLIER }, // 10 disconnects per 2 sec
    'tablet-get-recording-status': { window: 1000, max: 10 * DEV_MULTIPLIER }, // 10 status requests/sec
    'tablet-sync-metadata': { window: 1000, max: 5 * DEV_MULTIPLIER }, // 5 syncs/sec

    // === DEFAULT ===
    'default': { window: 1000, max: 50 * DEV_MULTIPLIER } // 50 events/sec default
}

/**
 * Checks if a Socket.IO event should be rate limited.
 *
 * This function implements a sliding window rate limit for Socket.IO events.
 * Each socket has independent rate limit tracking per event type.
 *
 * @param socketId - The Socket.IO socket identifier
 * @param eventName - The name of the event being processed
 * @returns `true` if the rate limit is exceeded (event should be blocked),
 *          `false` if the event is within limits (event should be allowed)
 *
 * @example
 * ```typescript
 * socket.on('headset-frame', (data) => {
 *   if (checkSocketRateLimit(socket.id, 'headset-frame')) {
 *     // Rate limit exceeded, silently drop the event
 *     return
 *   }
 *   // Process the frame...
 * })
 * ```
 */
export function checkSocketRateLimit(socketId: string, eventName: string): boolean {
    const now: number = Date.now()
    const config: SocketRateLimitConfig = SOCKET_RATE_LIMITS[eventName] ?? SOCKET_RATE_LIMITS['default']

    // Get or create socket's rate limit map
    let socketLimits = socketRateLimits.get(socketId)
    if (!socketLimits) {
        socketLimits = new Map()
        socketRateLimits.set(socketId, socketLimits)
    }

    // Get or create entry for this event
    let entry = socketLimits.get(eventName)
    if (!entry || now >= entry.resetTime) {
        entry = { count: 0, resetTime: now + config.window }
        socketLimits.set(eventName, entry)
    }

    entry.count++

    if (entry.count > config.max) {
        socketLogger.warn(
            { socketId, eventName, count: entry.count, limit: config.max },
            `Socket rate limit exceeded for event "${eventName}". Event blocked.`
        )
        return true // Block
    }

    return false // Allow
}

/**
 * Cleans up all rate limit entries for a disconnected socket.
 *
 * Should be called when a socket disconnects to free memory
 * and prevent the rate limit map from growing unbounded.
 *
 * @param socketId - The Socket.IO socket identifier to clean up
 *
 * @example
 * ```typescript
 * socket.on('disconnect', () => {
 *   cleanupSocketRateLimit(socket.id)
 * })
 * ```
 */
export function cleanupSocketRateLimit(socketId: string): void {
    socketRateLimits.delete(socketId)
}

/**
 * Performs periodic cleanup of expired rate limit entries.
 *
 * This function removes entries where the rate limit window has expired
 * and cleans up sockets with no remaining entries. This prevents memory
 * leaks from sockets that have been idle but not disconnected.
 *
 * This is called automatically every minute via setInterval.
 *
 * @example
 * ```typescript
 * // Manual cleanup (usually not needed, runs automatically)
 * cleanupExpiredRateLimits()
 * ```
 */
export function cleanupExpiredRateLimits(): void {
    const now: number = Date.now()
    let cleanedEntries: number = 0
    let cleanedSockets: number = 0

    for (const [socketId, socketLimits] of socketRateLimits.entries()) {
        for (const [eventName, entry] of socketLimits.entries()) {
            if (now >= entry.resetTime) {
                socketLimits.delete(eventName)
                cleanedEntries++
            }
        }

        if (socketLimits.size === 0) {
            socketRateLimits.delete(socketId)
            cleanedSockets++
        }
    }

    // Only log if something was cleaned (reduce noise)
    if (cleanedEntries > 0 || cleanedSockets > 0) {
        socketLogger.debug(
            { cleanedEntries, cleanedSockets },
            'Cleaned up expired rate limit entries'
        )
    }
}

// Run cleanup every minute
setInterval(cleanupExpiredRateLimits, 60 * 1000)

export default {
    apiLimiter,
    uploadLimiter,
    authLimiter,
    metricsLimiter,
    healthLimiter,
    checkSocketRateLimit,
    cleanupSocketRateLimit,
    cleanupExpiredRateLimits
}
