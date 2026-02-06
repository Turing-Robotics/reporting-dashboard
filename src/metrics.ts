/**
 * Prometheus Metrics module for Turing VR Backend
 *
 * Provides Prometheus-compatible metrics for:
 * - Device connections and status
 * - Session management
 * - Upload operations
 * - Socket.IO performance
 * - System health
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'
import { Router, Request, Response } from 'express'

// =============================================================================
// REGISTRY
// =============================================================================

// Create a custom registry (allows multiple instances)
export const registry = new Registry()

// Add default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: registry, prefix: 'turing_' })

// =============================================================================
// DEVICE METRICS
// =============================================================================

export const connectedDevices = new Gauge({
    name: 'turing_connected_devices_total',
    help: 'Total number of connected devices',
    labelNames: ['type'] as const, // 'headset' or 'tablet'
    registers: [registry]
})

export const lockedDevices = new Gauge({
    name: 'turing_locked_devices_total',
    help: 'Number of devices currently locked by tablets',
    registers: [registry]
})

export const recordingDevices = new Gauge({
    name: 'turing_recording_devices_total',
    help: 'Number of devices currently recording',
    registers: [registry]
})

export const deviceConnections = new Counter({
    name: 'turing_device_connections_total',
    help: 'Total device connection events',
    labelNames: ['type', 'event'] as const, // event: 'connect' | 'disconnect'
    registers: [registry]
})

export const deviceLockOperations = new Counter({
    name: 'turing_device_lock_operations_total',
    help: 'Total device lock/unlock operations',
    labelNames: ['operation', 'success'] as const, // operation: 'lock' | 'unlock', success: 'true' | 'false'
    registers: [registry]
})

// =============================================================================
// SESSION METRICS
// =============================================================================

export const activeSessions = new Gauge({
    name: 'turing_sessions_active_total',
    help: 'Number of active capture sessions',
    registers: [registry]
})

export const sessionsCreated = new Counter({
    name: 'turing_sessions_created_total',
    help: 'Total sessions created',
    registers: [registry]
})

export const sessionDuration = new Histogram({
    name: 'turing_session_duration_seconds',
    help: 'Session duration in seconds',
    buckets: [60, 300, 600, 1800, 3600, 7200], // 1min to 2hrs
    registers: [registry]
})

// =============================================================================
// UPLOAD METRICS
// =============================================================================

export const uploadDuration = new Histogram({
    name: 'turing_upload_duration_seconds',
    help: 'Upload duration in seconds',
    labelNames: ['file_type'] as const, // 'video' | 'data'
    buckets: [1, 5, 15, 30, 60, 120, 300, 600], // 1sec to 10min
    registers: [registry]
})

export const uploadSize = new Histogram({
    name: 'turing_upload_size_bytes',
    help: 'Upload file size in bytes',
    labelNames: ['file_type'] as const,
    buckets: [1e6, 1e7, 1e8, 5e8, 1e9, 5e9, 1e10], // 1MB to 10GB
    registers: [registry]
})

export const uploadErrors = new Counter({
    name: 'turing_upload_errors_total',
    help: 'Total upload errors',
    labelNames: ['error_type'] as const,
    registers: [registry]
})

export const uploadsInProgress = new Gauge({
    name: 'turing_uploads_in_progress',
    help: 'Number of uploads currently in progress',
    registers: [registry]
})

export const uploadBytesTotal = new Counter({
    name: 'turing_upload_bytes_total',
    help: 'Total bytes uploaded',
    labelNames: ['file_type'] as const, // 'video' | 'data'
    registers: [registry]
})

// =============================================================================
// SOCKET.IO METRICS
// =============================================================================

export const socketMessages = new Counter({
    name: 'turing_socket_messages_total',
    help: 'Total Socket.IO messages',
    labelNames: ['event_type', 'direction'] as const, // direction: 'in' | 'out'
    registers: [registry]
})

export const socketEventsTotal = new Counter({
    name: 'turing_socket_events_total',
    help: 'Total Socket.IO events by event type',
    labelNames: ['event'] as const,
    registers: [registry]
})

export const frameBatchSize = new Histogram({
    name: 'turing_frame_batch_size',
    help: 'Number of frames in each batch',
    buckets: [1, 5, 10, 20, 50, 100],
    registers: [registry]
})

export const frameDropped = new Counter({
    name: 'turing_frames_dropped_total',
    help: 'Total frames dropped due to throttling',
    registers: [registry]
})

export const socketConnectionDuration = new Histogram({
    name: 'turing_socket_connection_duration_seconds',
    help: 'Socket connection duration in seconds',
    labelNames: ['type'] as const,
    buckets: [60, 300, 900, 1800, 3600, 7200, 14400], // 1min to 4hrs
    registers: [registry]
})

// =============================================================================
// FLEET METRICS
// =============================================================================

export const fleetBatteryLevel = new Gauge({
    name: 'turing_fleet_battery_level',
    help: 'Device battery level (0-100)',
    labelNames: ['device_id'] as const,
    registers: [registry]
})

export const lowBatteryDevices = new Gauge({
    name: 'turing_low_battery_devices_total',
    help: 'Number of devices with battery below 20%',
    registers: [registry]
})

export const dashboardSubscribers = new Gauge({
    name: 'turing_dashboard_subscribers_total',
    help: 'Number of dashboard clients subscribed to fleet updates',
    registers: [registry]
})

// =============================================================================
// HTTP METRICS
// =============================================================================

export const httpRequestDuration = new Histogram({
    name: 'turing_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [registry]
})

export const httpRequestsTotal = new Counter({
    name: 'turing_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry]
})

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Update device count metrics
 */
export function updateDeviceCounts(headsets: number, tablets: number, locked: number, recording: number) {
    connectedDevices.set({ type: 'headset' }, headsets)
    connectedDevices.set({ type: 'tablet' }, tablets)
    lockedDevices.set(locked)
    recordingDevices.set(recording)
}

/**
 * Track device connection
 */
export function trackDeviceConnect(type: 'headset' | 'tablet') {
    deviceConnections.inc({ type, event: 'connect' })
    connectedDevices.inc({ type })
}

/**
 * Track device disconnection
 */
export function trackDeviceDisconnect(type: 'headset' | 'tablet') {
    deviceConnections.inc({ type, event: 'disconnect' })
    connectedDevices.dec({ type })
}

/**
 * Track device lock operation
 */
export function trackDeviceLock(success: boolean) {
    deviceLockOperations.inc({ operation: 'lock', success: success ? 'true' : 'false' })
    if (success) lockedDevices.inc()
}

/**
 * Track device unlock operation
 */
export function trackDeviceUnlock() {
    deviceLockOperations.inc({ operation: 'unlock', success: 'true' })
    lockedDevices.dec()
}

/**
 * Track session creation
 */
export function trackSessionCreated() {
    sessionsCreated.inc()
    activeSessions.inc()
}

/**
 * Track session completion
 */
export function trackSessionCompleted(durationSeconds: number) {
    activeSessions.dec()
    sessionDuration.observe(durationSeconds)
}

/**
 * Track upload start
 */
export function trackUploadStart() {
    uploadsInProgress.inc()
}

/**
 * Track upload completion
 */
export function trackUploadComplete(fileType: 'video' | 'data', durationSeconds: number, sizeBytes: number) {
    uploadsInProgress.dec()
    uploadDuration.observe({ file_type: fileType }, durationSeconds)
    uploadSize.observe({ file_type: fileType }, sizeBytes)
    uploadBytesTotal.inc({ file_type: fileType }, sizeBytes)
}

/**
 * Track upload bytes (for chunked uploads)
 */
export function trackUploadBytes(fileType: 'video' | 'data', bytes: number) {
    uploadBytesTotal.inc({ file_type: fileType }, bytes)
}

/**
 * Track upload error
 */
export function trackUploadError(errorType: string) {
    uploadsInProgress.dec()
    uploadErrors.inc({ error_type: errorType })
}

/**
 * Track Socket.IO message
 */
export function trackSocketMessage(eventType: string, direction: 'in' | 'out') {
    socketMessages.inc({ event_type: eventType, direction })
}

/**
 * Track Socket.IO event by type
 */
export function trackSocketEvent(event: string) {
    socketEventsTotal.inc({ event })
}

/**
 * Track frame batch emission
 */
export function trackFrameBatch(batchSize: number) {
    frameBatchSize.observe(batchSize)
}

/**
 * Track dropped frames
 */
export function trackFrameDropped(count: number = 1) {
    frameDropped.inc(count)
}

/**
 * Update device battery level
 */
export function updateBatteryLevel(deviceId: string, level: number) {
    fleetBatteryLevel.set({ device_id: deviceId }, level)
}

/**
 * Update low battery count
 */
export function updateLowBatteryCount(count: number) {
    lowBatteryDevices.set(count)
}

/**
 * Track dashboard subscription
 */
export function trackDashboardSubscribe() {
    dashboardSubscribers.inc()
}

/**
 * Track dashboard unsubscription
 */
export function trackDashboardUnsubscribe() {
    dashboardSubscribers.dec()
}

// =============================================================================
// EXPRESS MIDDLEWARE
// =============================================================================

/**
 * Express middleware for HTTP request metrics
 */
export function metricsMiddleware(req: Request, res: Response, next: () => void) {
    const startTime = Date.now()

    res.on('finish', () => {
        const durationSeconds = (Date.now() - startTime) / 1000
        const route = req.route?.path ?? req.path ?? 'unknown'

        httpRequestDuration.observe(
            { method: req.method, route, status_code: res.statusCode.toString() },
            durationSeconds
        )
        httpRequestsTotal.inc(
            { method: req.method, route, status_code: res.statusCode.toString() }
        )
    })

    next()
}

// =============================================================================
// METRICS ENDPOINT ROUTER
// =============================================================================

/**
 * Create Express router for metrics endpoint
 */
export function createMetricsRouter(): Router {
    const router = Router()

    // Prometheus metrics endpoint
    router.get('/metrics', async (req: Request, res: Response) => {
        try {
            res.set('Content-Type', registry.contentType)
            res.end(await registry.metrics())
        } catch (err: any) {
            res.status(500).json({ ok: false, error: err.message })
        }
    })

    // Health check with basic metrics
    router.get('/health', (req: Request, res: Response) => {
        res.json({
            ok: true,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            timestamp: new Date().toISOString()
        })
    })

    return router
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    registry,
    // Metrics
    connectedDevices,
    lockedDevices,
    recordingDevices,
    deviceConnections,
    deviceLockOperations,
    activeSessions,
    sessionsCreated,
    sessionDuration,
    uploadDuration,
    uploadSize,
    uploadErrors,
    uploadsInProgress,
    uploadBytesTotal,
    socketMessages,
    socketEventsTotal,
    frameBatchSize,
    frameDropped,
    socketConnectionDuration,
    fleetBatteryLevel,
    lowBatteryDevices,
    dashboardSubscribers,
    httpRequestDuration,
    httpRequestsTotal,
    // Helpers
    updateDeviceCounts,
    trackDeviceConnect,
    trackDeviceDisconnect,
    trackDeviceLock,
    trackDeviceUnlock,
    trackSessionCreated,
    trackSessionCompleted,
    trackUploadStart,
    trackUploadComplete,
    trackUploadBytes,
    trackUploadError,
    trackSocketMessage,
    trackSocketEvent,
    trackFrameBatch,
    trackFrameDropped,
    updateBatteryLevel,
    updateLowBatteryCount,
    trackDashboardSubscribe,
    trackDashboardUnsubscribe,
    // Middleware
    metricsMiddleware,
    createMetricsRouter
}
