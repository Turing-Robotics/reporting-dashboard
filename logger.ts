/**
 * Structured Logging module for Turing VR Backend
 *
 * Uses pino for high-performance, structured JSON logging.
 * Provides context-specific loggers for different modules.
 *
 * @module logger
 */

import pino, { Logger } from 'pino'
import { Request, Response, NextFunction } from 'express'

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Log level from environment or default to 'info' */
const LOG_LEVEL: string = process.env.LOG_LEVEL ?? 'info'

/** Node environment from environment or default to 'development' */
const NODE_ENV: string = process.env.NODE_ENV ?? 'development'

/** Whether the application is running in development mode */
const isDevelopment: boolean = NODE_ENV !== 'production'

// =============================================================================
// BASE LOGGER
// =============================================================================

// Create base logger with different transports for dev vs prod
const baseLogger = pino({
    level: LOG_LEVEL,

    // Structured log format with custom fields
    formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => ({
            pid: bindings.pid,
            hostname: bindings.hostname,
            service: 'turing-backend'
        })
    },

    // Add timestamp in ISO format
    timestamp: pino.stdTimeFunctions.isoTime,

    // Redact sensitive fields
    redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token', 'apiKey'],
        censor: '[REDACTED]'
    },

    // Pretty print in development
    transport: isDevelopment
        ? {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                messageFormat: '{module} - {msg}'
            }
        }
        : undefined,

    // Custom serializers
    serializers: {
        err: pino.stdSerializers.err,
        req: (req) => ({
            method: req.method,
            url: req.url,
            path: req.path,
            query: req.query,
            ip: req.ip ?? req.remoteAddress
        }),
        res: (res) => ({
            statusCode: res.statusCode
        })
    }
})

// =============================================================================
// MODULE-SPECIFIC LOGGERS
// =============================================================================

/**
 * Creates a child logger with module context for categorized logging.
 *
 * @param moduleName - The name of the module to create a logger for
 * @returns A child logger instance with the module name attached to all log entries
 *
 * @example
 * ```typescript
 * const myLogger = createModuleLogger('my-module')
 * myLogger.info('This is a log message from my-module')
 * ```
 */
function createModuleLogger(moduleName: string): Logger {
    return baseLogger.child({ module: moduleName })
}

/** Logger for server startup, shutdown, and general server events */
export const serverLogger: Logger = createModuleLogger('server')

/** Logger for device management operations (connect, disconnect, state changes) */
export const deviceLogger: Logger = createModuleLogger('device')

/** Logger for session management operations (create, start, end) */
export const sessionLogger: Logger = createModuleLogger('session')

/** Logger for file upload operations (start, progress, complete, errors) */
export const uploadLogger: Logger = createModuleLogger('upload')

/** Logger for Socket.IO events and communication */
export const socketLogger: Logger = createModuleLogger('socket')

/** Logger for authentication and authorization events */
export const authLogger: Logger = createModuleLogger('auth')

/** Logger for fleet dashboard and telemetry operations */
export const fleetLogger: Logger = createModuleLogger('fleet')

/** Logger for database operations */
export const dbLogger: Logger = createModuleLogger('database')

/** Logger for Redis operations and state management */
export const redisLogger: Logger = createModuleLogger('redis')

// =============================================================================
// LOGGING HELPERS
// =============================================================================

/**
 * Logs a device connection event.
 *
 * @param deviceId - The unique identifier of the device
 * @param socketId - The Socket.IO socket identifier
 * @param deviceType - The type of device (e.g., 'headset', 'tablet')
 *
 * @example
 * ```typescript
 * logDeviceConnect('QUEST_001', 'abc123', 'headset')
 * ```
 */
export function logDeviceConnect(deviceId: string, socketId: string, deviceType: string): void {
    deviceLogger.info({ deviceId, socketId, deviceType, event: 'connect' }, 'Device connected')
}

/**
 * Logs a device disconnection event.
 *
 * @param deviceId - The unique identifier of the device
 * @param socketId - The Socket.IO socket identifier
 * @param reason - The reason for disconnection (e.g., 'transport close', 'ping timeout')
 *
 * @example
 * ```typescript
 * logDeviceDisconnect('QUEST_001', 'abc123', 'transport close')
 * ```
 */
export function logDeviceDisconnect(deviceId: string, socketId: string, reason: string): void {
    deviceLogger.info({ deviceId, socketId, reason, event: 'disconnect' }, 'Device disconnected')
}

/**
 * Logs a device lock event (success or failure).
 *
 * @param deviceId - The unique identifier of the device being locked
 * @param tabletId - The Socket.IO socket ID of the tablet requesting the lock
 * @param success - Whether the lock operation succeeded
 * @param reason - Optional reason for lock failure
 *
 * @example
 * ```typescript
 * logDeviceLock('QUEST_001', 'tablet_abc', true)
 * logDeviceLock('QUEST_001', 'tablet_xyz', false, 'Device locked by another tablet')
 * ```
 */
export function logDeviceLock(deviceId: string, tabletId: string, success: boolean, reason?: string): void {
    const level: 'info' | 'warn' = success ? 'info' : 'warn'
    deviceLogger[level](
        { deviceId, tabletId, success, reason, event: 'lock' },
        success ? 'Device locked' : 'Device lock failed'
    )
}

/**
 * Logs a device unlock event.
 *
 * @param deviceId - The unique identifier of the device being unlocked
 * @param tabletId - The Socket.IO socket ID of the tablet releasing the lock
 *
 * @example
 * ```typescript
 * logDeviceUnlock('QUEST_001', 'tablet_abc')
 * ```
 */
export function logDeviceUnlock(deviceId: string, tabletId: string): void {
    deviceLogger.info({ deviceId, tabletId, event: 'unlock' }, 'Device unlocked')
}

/**
 * Logs a session lifecycle event (created, started, paused, ended, etc.).
 *
 * @param sessionId - The unique identifier of the capture session
 * @param status - The new status of the session
 * @param deviceCount - The number of devices participating in the session
 * @param extra - Optional additional data to include in the log entry
 *
 * @example
 * ```typescript
 * logSession('session_123', 'created', 3, { unavailable: 1 })
 * logSession('session_123', 'started', 3)
 * ```
 */
export function logSession(sessionId: string, status: string, deviceCount: number, extra?: Record<string, unknown>): void {
    sessionLogger.info({ sessionId, status, deviceCount, ...extra, event: 'session' }, `Session ${status}`)
}

/**
 * Logs an upload operation event (started, progress, completed, or failed).
 *
 * @param timestamp - The session timestamp identifier
 * @param fileType - The type of file being uploaded (e.g., 'video', 'data')
 * @param status - The current status of the upload operation
 * @param extra - Optional additional data (e.g., progress percentage, error details)
 *
 * @example
 * ```typescript
 * logUpload('20250114_120000', 'video', 'started', { sizeMB: 500 })
 * logUpload('20250114_120000', 'video', 'failed', { error: 'S3 timeout' })
 * ```
 */
export function logUpload(
    timestamp: string,
    fileType: string,
    status: 'started' | 'progress' | 'completed' | 'failed',
    extra?: Record<string, unknown>
): void {
    const level: 'error' | 'info' = status === 'failed' ? 'error' : 'info'
    uploadLogger[level]({ timestamp, fileType, status, ...extra, event: 'upload' }, `Upload ${status}`)
}

/**
 * Logs device telemetry data received from a headset.
 *
 * @param deviceId - The unique identifier of the device
 * @param batteryLevel - The current battery level (0-1)
 * @param isRecording - Whether the device is currently recording
 *
 * @example
 * ```typescript
 * logTelemetry('QUEST_001', 0.85, true)
 * ```
 */
export function logTelemetry(deviceId: string, batteryLevel: number, isRecording: boolean): void {
    fleetLogger.debug({ deviceId, batteryLevel, isRecording, event: 'telemetry' }, 'Telemetry received')
}

/**
 * Logs an authentication event (success or failure).
 *
 * @param socketId - The Socket.IO socket identifier
 * @param deviceId - The device identifier (if available)
 * @param success - Whether authentication succeeded
 * @param reason - Optional reason for authentication failure
 *
 * @example
 * ```typescript
 * logAuth('socket_abc', 'QUEST_001', true)
 * logAuth('socket_xyz', null, false, 'Invalid token')
 * ```
 */
export function logAuth(socketId: string, deviceId: string | null, success: boolean, reason?: string): void {
    const level: 'info' | 'warn' = success ? 'info' : 'warn'
    authLogger[level]({ socketId, deviceId, success, reason, event: 'auth' }, success ? 'Auth success' : 'Auth failed')
}

/**
 * Logs an HTTP request with response details and timing.
 *
 * @param req - The Express request object
 * @param res - The Express response object
 * @param responseTime - The time taken to process the request in milliseconds
 *
 * @example
 * ```typescript
 * logRequest(req, res, 45) // Logs: GET /api/devices 200 in 45ms
 * ```
 */
export function logRequest(req: Request, res: Response, responseTime: number): void {
    const level: 'error' | 'warn' | 'info' = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
    baseLogger[level](
        {
            module: 'http',
            method: req.method,
            url: req.originalUrl ?? req.url,
            statusCode: res.statusCode,
            responseTime: `${responseTime}ms`,
            ip: req.ip ?? (req as Request & { connection?: { remoteAddress?: string } }).connection?.remoteAddress
        },
        `${req.method} ${req.originalUrl ?? req.url} ${res.statusCode}`
    )
}

/**
 * Logs an error with full stack trace and optional additional context.
 *
 * @param module - The name of the module where the error occurred
 * @param message - A descriptive message about the error
 * @param error - The Error object with stack trace
 * @param extra - Optional additional context data
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation()
 * } catch (err) {
 *   logError('upload', 'Failed to upload file to S3', err as Error, { bucket: 'my-bucket' })
 * }
 * ```
 */
export function logError(module: string, message: string, error: Error, extra?: Record<string, unknown>): void {
    const logger: Logger = createModuleLogger(module)
    logger.error({ err: error, ...extra, event: 'error' }, message)
}

/**
 * Logs a Socket.IO event for debugging real-time communication.
 *
 * @param direction - Whether the event is incoming ('in') or outgoing ('out')
 * @param eventName - The name of the Socket.IO event
 * @param socketId - The Socket.IO socket identifier
 * @param deviceId - Optional device identifier associated with the event
 * @param extra - Optional additional context data
 *
 * @example
 * ```typescript
 * logSocketEvent('in', 'headset-identify', 'socket_abc', 'QUEST_001')
 * logSocketEvent('out', 'on-device-locked', 'socket_xyz', 'QUEST_001', { tabletId: 'tablet_123' })
 * ```
 */
export function logSocketEvent(
    direction: 'in' | 'out',
    eventName: string,
    socketId: string,
    deviceId?: string,
    extra?: Record<string, unknown>
): void {
    socketLogger.debug(
        { direction, eventName, socketId, deviceId, ...extra, event: 'socket' },
        `${direction === 'in' ? '<<' : '>>'} ${eventName}`
    )
}

// =============================================================================
// EXPRESS MIDDLEWARE
// =============================================================================

/**
 * Express middleware that automatically logs all HTTP requests with timing information.
 *
 * Logs the request when the response finishes, including:
 * - HTTP method and URL
 * - Response status code
 * - Response time in milliseconds
 * - Client IP address
 *
 * @param req - The Express request object
 * @param res - The Express response object
 * @param next - The next middleware function in the chain
 *
 * @example
 * ```typescript
 * import { requestLoggerMiddleware } from './logger'
 *
 * app.use(requestLoggerMiddleware)
 * ```
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startTime: number = Date.now()

    // Log on response finish
    res.on('finish', () => {
        const responseTime: number = Date.now() - startTime
        logRequest(req, res, responseTime)
    })

    next()
}

// =============================================================================
// EXPORTS
// =============================================================================

export default baseLogger

export {
    baseLogger as logger,
    createModuleLogger
}
