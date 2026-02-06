/**
 * Turing VR Backend Server - Multi-Device Support
 *
 * Main server module providing:
 * - Socket.IO real-time communication between tablets and Quest headsets
 * - REST API for fleet management and file uploads
 * - Device locking for exclusive tablet-to-headset control
 * - Session management for multi-device capture coordination
 * - S3 integration for chunked file uploads
 *
 * @module multidevice_complete
 */

import 'dotenv/config'

import express, { Request, Response } from 'express'
import helmet from 'helmet'
import http from 'http'
import multer from 'multer'
import { Server, Socket } from 'socket.io'
import {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListPartsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Security modules
import { socketAuthMiddleware, createAuthRouter } from './auth'
import { apiLimiter, uploadLimiter, authLimiter, healthLimiter, checkSocketRateLimit, cleanupSocketRateLimit } from './rateLimiter'
// Note: Validation is done inline for now. Import schemas when refactoring to use withValidation()
// import { validate, lockDevicesSchema, createSessionSchema, deviceTelemetrySchema, headsetIdentifySchema } from './validation'

// Redis state management (optional - falls back to in-memory if unavailable)
import {
    initRedis,
    isRedisAvailable,
    getRedisClient,
    setDeviceState as redisSetDeviceState,
    markDeviceOffline as redisMarkDeviceOffline,
    shutdownRedis
} from './redis'

// Socket.IO Redis Streams adapter for horizontal scaling
import { createAdapter } from '@socket.io/redis-streams-adapter'

// Logging and metrics
import {
    serverLogger,
    socketLogger,
    uploadLogger,
    fleetLogger,
    sessionLogger,
    deviceLogger,
    logDeviceConnect,
    logDeviceDisconnect,
    logDeviceLock,
    logDeviceUnlock,
    logSession,
    requestLoggerMiddleware
} from './logger'
import {
    createMetricsRouter,
    metricsMiddleware,
    trackDeviceConnect,
    trackDeviceDisconnect,
    trackDeviceLock,
    trackDeviceUnlock,
    trackSessionCreated,
    trackSessionCompleted,
    trackUploadStart,
    trackUploadError,
    trackSocketEvent,
    trackDashboardSubscribe,
    trackDashboardUnsubscribe,
    updateBatteryLevel
} from './metrics'

import multerS3 from 'multer-s3'

// =============================================================================
// SOCKET.IO EVENT NAME CONSTANTS
// =============================================================================

/**
 * Socket.IO event names for headset-initiated events.
 * These events are emitted by Quest headsets to the server.
 */
const HEADSET_EVENTS = {
    /** Headset identifies itself with device ID */
    IDENTIFY: 'headset-identify',
    /** Headset sends a video frame */
    FRAME: 'headset-frame',
    /** Headset sends status update */
    STATUS: 'headset-status',
    /** Headset reports recording state change */
    RECORDING_STATE: 'headset-recording-state',
    /** Headset confirms logs were processed */
    LOGS_PROCESSED: 'headset-logs-processed',
} as const

/**
 * Socket.IO event names for tablet-initiated events.
 * These events are emitted by iOS tablets to the server.
 */
const TABLET_EVENTS = {
    /** Tablet requests to lock a single device */
    LOCK_DEVICE: 'tablet-lock-device',
    /** Tablet requests to unlock a single device */
    UNLOCK_DEVICE: 'tablet-unlock-device',
    /** Tablet requests to lock multiple devices */
    LOCK_DEVICES: 'tablet-lock-devices',
    /** Tablet requests to unlock all devices */
    UNLOCK_ALL_DEVICES: 'tablet-unlock-all-devices',
    /** Tablet toggles recording (deprecated) */
    TOGGLE_RECORDING: 'tablet-toggle-recording',
    /** Tablet toggles recording for all devices (deprecated) */
    TOGGLE_ALL_RECORDING: 'tablet-toggle-all-recording',
    /** Tablet starts recording for a device */
    START_RECORDING: 'tablet-start-recording',
    /** Tablet stops recording for a device */
    STOP_RECORDING: 'tablet-stop-recording',
    /** Tablet starts recording for all devices */
    START_ALL_RECORDING: 'tablet-start-all-recording',
    /** Tablet stops recording for all devices */
    STOP_ALL_RECORDING: 'tablet-stop-all-recording',
    /** Tablet creates a new session */
    CREATE_SESSION: 'tablet-create-session',
    /** Tablet starts a session */
    START_SESSION: 'tablet-start-session',
    /** Tablet pauses a session */
    PAUSE_SESSION: 'tablet-pause-session',
    /** Tablet ends a session */
    END_SESSION: 'tablet-end-session',
    /** Tablet requests session info */
    GET_SESSION: 'tablet-get-session',
    /** Tablet requests active session info */
    GET_ACTIVE_SESSION: 'tablet-get-active-session',
    /** Legacy: Tablet connects to headset */
    CONNECT_HEADSET: 'tablet-connect-headset',
    /** Legacy: Tablet disconnects from headset */
    DISCONNECT_HEADSET: 'tablet-disconnect-headset',
    /** Tablet requests recording status */
    GET_RECORDING_STATUS: 'tablet-get-recording-status',
    /** Tablet syncs metadata to headset */
    SYNC_METADATA: 'tablet-sync-metadata',
} as const

/**
 * Socket.IO event names for server-to-client events.
 * These events are emitted by the server to tablets and headsets.
 */
const SERVER_EVENTS = {
    /** Headset connection confirmed */
    HEADSET_CONNECTED: 'on-headset-connected',
    /** Headset disconnected */
    HEADSET_DISCONNECTED: 'on-headset-disconnected',
    /** Updated list of headsets (legacy) */
    HEADSETS_UPDATED: 'on-headsets-updated',
    /** Updated list of headsets with lock status */
    HEADSETS_WITH_LOCK_STATUS_UPDATED: 'on-headsets-with-lock-status-updated',
    /** Device lock status changed */
    DEVICE_LOCKS_UPDATED: 'on-device-locks-updated',
    /** Device lock confirmed */
    DEVICE_LOCKED: 'on-device-locked',
    /** Device lock failed */
    DEVICE_LOCK_FAILED: 'on-device-lock-failed',
    /** Device unlocked */
    DEVICE_UNLOCKED: 'on-device-unlocked',
    /** Multiple devices locked */
    DEVICES_LOCKED: 'on-devices-locked',
    /** All devices unlocked */
    ALL_DEVICES_UNLOCKED: 'on-all-devices-unlocked',
    /** Device disconnected */
    DEVICE_DISCONNECTED: 'on-device-disconnected',
    /** Device recording state changed */
    DEVICE_RECORDING_CHANGED: 'on-device-recording-changed',
    /** Recording toggle denied */
    RECORDING_TOGGLE_DENIED: 'on-recording-toggle-denied',
    /** Recording denied */
    RECORDING_DENIED: 'on-recording-denied',
    /** Recording started (legacy) */
    RECORDING_ACTIVE: 'on-recording-active',
    /** Recording stopped (legacy) */
    RECORDING_INACTIVE: 'on-recording-inactive',
    /** Headset recording active (legacy) */
    HEADSET_RECORDING_ACTIVE: 'on-headset-recording-active',
    /** Headset recording inactive (legacy) */
    HEADSET_RECORDING_INACTIVE: 'on-headset-recording-inactive',
    /** Recording toggled command */
    TABLET_RECORDING_TOGGLED: 'on-tablet-recording-toggled',
    /** Start recording command */
    TABLET_START_RECORDING: 'on-tablet-start-recording',
    /** Stop recording command */
    TABLET_STOP_RECORDING: 'on-tablet-stop-recording',
    /** Metadata synced to headset */
    TABLET_METADATA_SYNCED: 'on-tablet-metadata-synced',
    /** Headset status updated */
    HEADSET_STATUS_UPDATED: 'on-headset-status-updated',
    /** Headset frame updated */
    HEADSET_FRAME_UPDATED: 'on-headset-frame-updated',
    /** Headset logs processed */
    HEADSET_LOGS_PROCESSED: 'on-headset-logs-processed',
    /** Session created */
    SESSION_CREATED: 'on-session-created',
    /** Session started */
    SESSION_STARTED: 'on-session-started',
    /** Session paused */
    SESSION_PAUSED: 'on-session-paused',
    /** Session ended */
    SESSION_ENDED: 'on-session-ended',
    /** Session error */
    SESSION_ERROR: 'on-session-error',
    /** Session status response */
    SESSION_STATUS: 'on-session-status',
    /** Active session response */
    ACTIVE_SESSION: 'on-active-session',
    /** Fleet status for dashboard */
    FLEET_STATUS_UPDATED: 'on-fleet-status-updated',
    /** Device telemetry for dashboard */
    DEVICE_TELEMETRY_UPDATED: 'on-device-telemetry-updated',
    /** Generic error */
    ERROR: 'error',
} as const

/**
 * Socket.IO event names for dashboard/fleet events.
 */
const DASHBOARD_EVENTS = {
    /** Dashboard subscribes to telemetry */
    SUBSCRIBE: 'dashboard-subscribe',
    /** Dashboard unsubscribes from telemetry */
    UNSUBSCRIBE: 'dashboard-unsubscribe',
    /** Device telemetry received */
    DEVICE_TELEMETRY: 'device-telemetry',
} as const

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validates that a value is a valid device ID.
 *
 * @param deviceId - The value to validate
 * @returns `true` if the value is a valid device ID string
 */
function isValidDeviceId(deviceId: unknown): deviceId is string {
    return typeof deviceId === 'string' &&
           deviceId.length > 0 &&
           deviceId.length <= MAX_DEVICE_ID_LENGTH &&
           /^[a-zA-Z0-9_-]+$/.test(deviceId)
}

// =============================================================================
// CONFIGURATION (extracted to environment variables with defaults)
// =============================================================================

// Server configuration
const PORT = parseInt(process.env.PORT ?? '3200', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

// Broadcast frequency configuration
const CONNECTED_HEADSETS_BROADCAST_FREQUENCY = parseInt(process.env.HEADSET_BROADCAST_FREQUENCY_MS ?? '1000', 10)

// Chunked upload configuration
const CHUNK_SIZE = parseInt(process.env.UPLOAD_CHUNK_SIZE_MB ?? '10', 10) * 1024 * 1024 // Default 10MB per chunk
const MAX_CHUNKS = parseInt(process.env.UPLOAD_MAX_CHUNKS ?? '10000', 10) // S3 limit
const PRESIGNED_URL_EXPIRY = parseInt(process.env.PRESIGNED_URL_EXPIRY_SECONDS ?? '3600', 10) // Default 1 hour

// === REAL-TIME OPTIMIZATION CONFIG ===
const FRAME_BATCH_INTERVAL_MS = parseInt(process.env.FRAME_BATCH_INTERVAL_MS ?? '33', 10) // ~30 batches/sec for smooth real-time
const FRAME_THROTTLE_MS = parseInt(process.env.FRAME_THROTTLE_MS ?? '16', 10) // Max ~60fps per headset (prevent flooding)
const MAX_FRAME_BATCH_SIZE = parseInt(process.env.MAX_FRAME_BATCH_SIZE ?? '5', 10) // Max frames per batch to prevent memory growth

// === MEMORY MANAGEMENT CONFIG ===
const SESSION_CLEANUP_INTERVAL_MS = parseInt(process.env.SESSION_CLEANUP_INTERVAL_MS ?? '3600000', 10) // Default 1 hour
const SESSION_EXPIRY_MS = parseInt(process.env.SESSION_EXPIRY_MS ?? '86400000', 10) // Default 24 hours
const OFFLINE_DEVICE_EXPIRY_MS = parseInt(process.env.OFFLINE_DEVICE_EXPIRY_MS ?? '604800000', 10) // Default 7 days
const TELEMETRY_HISTORY_CLEANUP_INTERVAL_MS = parseInt(process.env.TELEMETRY_HISTORY_CLEANUP_INTERVAL_MS ?? '3600000', 10) // Default 1 hour

// Socket.IO configuration
const SOCKET_PING_INTERVAL_MS = parseInt(process.env.SOCKET_PING_INTERVAL_MS ?? '5000', 10)
const SOCKET_PING_TIMEOUT_MS = parseInt(process.env.SOCKET_PING_TIMEOUT_MS ?? '10000', 10)
const SOCKET_CONNECT_TIMEOUT_MS = parseInt(process.env.SOCKET_CONNECT_TIMEOUT_MS ?? '45000', 10)
const SOCKET_MAX_HTTP_BUFFER_SIZE = parseInt(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE ?? '100000000', 10) // 100MB

// Device validation configuration
const MAX_DEVICE_ID_LENGTH = parseInt(process.env.MAX_DEVICE_ID_LENGTH ?? '100', 10)
const MAX_DEVICES_PER_LOCK_REQUEST = parseInt(process.env.MAX_DEVICES_PER_LOCK_REQUEST ?? '50', 10)

// Legacy port variable for backwards compatibility
const port = PORT
const app = express()

// Security headers via helmet
app.use(helmet({
    contentSecurityPolicy: false, // Disable for Socket.IO compatibility
    crossOriginEmbedderPolicy: false // Disable for cross-origin resource loading
}))

app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true, limit: '5mb' }))

// Logging and metrics middleware
app.use(requestLoggerMiddleware)
app.use(metricsMiddleware)

// Mount metrics endpoint
app.use('/', createMetricsRouter())

// =============================================================================
// CORS CONFIGURATION
// =============================================================================

// Allowed origins - configure via environment variable or use defaults
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [
        'http://localhost:3000',      // Local dashboard
        'http://localhost:3001',      // Local dev server
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'https://quest.apidataupload.com',  // Production domain
        'http://quest.apidataupload.com',   // Production domain (HTTP)
        'https://dashboard.apidataupload.com', // Dashboard subdomain
        'http://dashboard.apidataupload.com',  // Dashboard subdomain (HTTP)
    ]

const isDevelopment = process.env.NODE_ENV !== 'production'

// CORS middleware for all routes
app.use((req, res, next) => {
    const origin = req.headers.origin

    // In development, allow all origins for easier testing
    if (isDevelopment) {
        res.header('Access-Control-Allow-Origin', origin || '*')
    } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin)
    }
    // If origin not in whitelist in production, don't set CORS header (request will fail)

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key')
    res.header('Access-Control-Allow-Credentials', 'true')

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200)
    }
    next()
})

// =============================================================================
// AWS / S3 CONFIG
// =============================================================================

const s3Region = process.env.AWS_REGION ?? 'eu-west-1'
const s3Bucket = process.env.S3_BUCKET_NAME ?? 'turing-robotics-datahub'

const s3 = new S3Client({
    region: s3Region,
    credentials: process.env.AWS_ACCESS_KEY_ID
        ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
          }
        : undefined,
})

// =============================================================================
// TYPES
// =============================================================================

/**
 * Request body for session upload endpoint.
 */
interface UploadSessionBody {
    /** Optional session identifier */
    sessionId?: string
    /** Timestamp identifier for the session */
    timestamp?: string
}

/**
 * Extended Multer file with S3 metadata.
 */
interface MulterS3File extends Express.Multer.File {
    /** S3 bucket name */
    bucket: string
    /** S3 object key */
    key: string
    /** Full S3 URL */
    location: string
    /** S3 ETag for the object */
    etag: string
}

/**
 * Structure of uploaded files from multer-s3.
 */
interface MulterFiles {
    /** Video files array (typically one) */
    video?: MulterS3File[]
    /** Data files array (typically one) */
    data?: MulterS3File[]
}

/**
 * Request body for starting a chunked upload.
 */
interface StartChunkedUploadRequest {
    /** Session timestamp identifier */
    timestamp: string
    /** Type of file being uploaded */
    fileType: 'video' | 'data'
    /** Total file size in bytes */
    fileSize: number
    /** Optional original filename */
    fileName?: string
}

/**
 * Request body for completing a chunked upload.
 */
interface CompleteChunkedUploadRequest {
    /** S3 multipart upload ID */
    uploadId: string
    /** S3 object key */
    s3Key: string
    /** Array of uploaded parts with ETags */
    parts: Array<{ partNumber: number; etag: string }>
}

// =============================================================================
// MULTER-S3 SETUP (for single-request uploads)
// =============================================================================

const upload = multer({
    storage: multerS3({
        s3,
        bucket: s3Bucket,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req: Request, file: Express.Multer.File, cb: (error: any, key?: string) => void) {
            const body = req.body as UploadSessionBody
            const timestamp = body.timestamp

            if (!timestamp) {
                return cb(new Error('timestamp field is required'))
            }

            const basePrefix = `sessions/${timestamp}/`

            if (file.fieldname === 'video') {
                return cb(null, `${basePrefix}recording.mp4`)
            }

            if (file.fieldname === 'data') {
                return cb(null, `${basePrefix}session_data.npz`)
            }

            return cb(null, `${basePrefix}${file.fieldname}`)
        },
    }),
    limits: {
        fileSize: 20 * 1024 * 1024 * 1024, // 20 GB per file
        files: 2,
    },
})

// =============================================================================
// REST API ROUTES
// =============================================================================

// =============================================================================
// RATE LIMITING
// =============================================================================

// Apply general API rate limiting to all /api routes
app.use('/api/', apiLimiter)

// Auth routes with stricter rate limiting
app.use('/auth', authLimiter, createAuthRouter())

// Health check with lenient rate limiting (for load balancers)
app.get('/test', healthLimiter, (req: Request, res: Response) => {
    res.json({ ok: true, message: 'Turing Backend v2.2 - Secure Multi-Device Support', time: new Date().toISOString() })
})

// Original single-request upload (kept for backwards compatibility)
app.post(
    '/upload-session',
    uploadLimiter, // Rate limiting for uploads
    upload.fields([
        { name: 'video', maxCount: 1 },
        { name: 'data', maxCount: 1 },
    ]),
    async (req: Request<unknown, unknown, UploadSessionBody>, res: Response): Promise<void> => {
        try {
            const { sessionId: bodySessionId, timestamp } = req.body

            if (!timestamp) {
                res.status(400).json({ ok: false, error: 'timestamp field is required' })
                return
            }

            const sessionId = bodySessionId ?? Date.now().toString()

            const files = (req.files ?? {}) as MulterFiles
            const videoFile = files.video?.[0]
            const dataFile = files.data?.[0]

            if (!videoFile || !dataFile) {
                res.status(400).json({
                    ok: false,
                    error: 'Both video and data files are required',
                })
                return
            }

            uploadLogger.info({ sessionId, timestamp, mp4Key: videoFile.key, npzKey: dataFile.key }, 'Uploading session files to S3')

            res.json({
                ok: true,
                sessionId,
                timestamp,
                mp4: {
                    bucket: videoFile.bucket,
                    key: videoFile.key,
                    location: videoFile.location,
                    etag: videoFile.etag,
                },
                npz: {
                    bucket: dataFile.bucket,
                    key: dataFile.key,
                    location: dataFile.location,
                    etag: dataFile.etag,
                },
            })
        } catch (err: any) {
            uploadLogger.error({ err, code: err?.code }, 'Error uploading session files')
            trackUploadError(err?.code ?? 'unknown')

            if (err?.code === 'LIMIT_FILE_SIZE') {
                res.status(413).json({ ok: false, error: 'file_too_large' })
                return
            }

            if (String(err?.message ?? '').includes('timestamp field is required')) {
                res.status(400).json({ ok: false, error: 'timestamp field is required' })
                return
            }

            res.status(500).json({ ok: false, error: 'upload_failed' })
        }
    }
)

// =============================================================================
// CHUNKED UPLOAD ENDPOINTS (for large files)
// =============================================================================

// 1. Start chunked upload
app.post('/chunked-upload/start', async (req: Request, res: Response): Promise<void> => {
    try {
        const { timestamp, fileType, fileSize, fileName } = req.body as StartChunkedUploadRequest

        if (!timestamp || !fileType || !fileSize) {
            res.status(400).json({
                ok: false,
                error: 'Missing required fields: timestamp, fileType, fileSize'
            })
            return
        }

        if (fileType !== 'video' && fileType !== 'data') {
            res.status(400).json({
                ok: false,
                error: 'fileType must be "video" or "data"'
            })
            return
        }

        const s3Key = fileType === 'video'
            ? `sessions/${timestamp}/recording.mp4`
            : `sessions/${timestamp}/session_data.npz`

        const totalParts = Math.ceil(fileSize / CHUNK_SIZE)

        if (totalParts > MAX_CHUNKS) {
            res.status(400).json({
                ok: false,
                error: `File too large. Max ${MAX_CHUNKS} chunks of ${CHUNK_SIZE / 1024 / 1024}MB = ${(MAX_CHUNKS * CHUNK_SIZE) / 1024 / 1024 / 1024}TB`
            })
            return
        }

        const createCommand = new CreateMultipartUploadCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            ContentType: fileType === 'video' ? 'video/mp4' : 'application/octet-stream',
        })

        const createResponse = await s3.send(createCommand)
        const uploadId = createResponse.UploadId

        if (!uploadId) {
            throw new Error('Failed to get uploadId from S3')
        }

        // Generate presigned URLs in parallel for better performance (10-100x faster for large files)
        const presignedUrlPromises = Array.from({ length: totalParts }, (_, i) => {
            const partNumber = i + 1
            const uploadPartCommand = new UploadPartCommand({
                Bucket: s3Bucket,
                Key: s3Key,
                UploadId: uploadId,
                PartNumber: partNumber,
            })
            return getSignedUrl(s3, uploadPartCommand, { expiresIn: PRESIGNED_URL_EXPIRY })
                .then(url => ({ partNumber, url }))
        })

        const presignedUrls = await Promise.all(presignedUrlPromises)

        uploadLogger.info({ s3Key, uploadId, totalParts, sizeMB: (fileSize / 1024 / 1024).toFixed(1) }, 'Chunked upload started')
        trackUploadStart()

        res.json({
            ok: true,
            uploadId,
            s3Key,
            totalParts,
            chunkSize: CHUNK_SIZE,
            presignedUrls,
        })

    } catch (error: any) {
        uploadLogger.error({ err: error }, 'Chunked upload start failed')
        trackUploadError('start_failed')
        res.status(500).json({ ok: false, error: 'Failed to start upload', details: error.message })
    }
})

// 2. Get upload status (for resume)
app.get('/chunked-upload/status', async (req: Request, res: Response): Promise<void> => {
    try {
        const uploadId = req.query.uploadId as string
        const s3Key = req.query.s3Key as string

        if (!uploadId || !s3Key) {
            res.status(400).json({
                ok: false,
                error: 'Missing required query params: uploadId, s3Key'
            })
            return
        }

        const listCommand = new ListPartsCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            UploadId: uploadId,
        })

        const listResponse = await s3.send(listCommand)

        const uploadedParts = (listResponse.Parts || []).map(part => ({
            partNumber: part.PartNumber!,
            etag: part.ETag!,
            size: part.Size!,
        }))

        res.json({
            ok: true,
            uploadId,
            s3Key,
            uploadedParts,
        })

    } catch (error: any) {
        uploadLogger.error({ err: error }, 'Chunked upload status check failed')
        res.status(500).json({ ok: false, error: 'Failed to get upload status', details: error.message })
    }
})

// 3. Get presigned URL for a single part
app.post('/chunked-upload/presign-part', async (req: Request, res: Response): Promise<void> => {
    try {
        const { uploadId, s3Key, partNumber } = req.body

        if (!uploadId || !s3Key || !partNumber) {
            res.status(400).json({
                ok: false,
                error: 'Missing required fields: uploadId, s3Key, partNumber'
            })
            return
        }

        const uploadPartCommand = new UploadPartCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            UploadId: uploadId,
            PartNumber: partNumber,
        })

        const presignedUrl = await getSignedUrl(s3, uploadPartCommand, {
            expiresIn: PRESIGNED_URL_EXPIRY,
        })

        res.json({ ok: true, partNumber, url: presignedUrl })

    } catch (error: any) {
        uploadLogger.error({ err: error }, 'Chunked upload presign part failed')
        res.status(500).json({ ok: false, error: 'Failed to generate presigned URL', details: error.message })
    }
})

// 4. Complete chunked upload
app.post('/chunked-upload/complete', async (req: Request, res: Response): Promise<void> => {
    try {
        const { uploadId, s3Key, parts } = req.body as CompleteChunkedUploadRequest

        if (!uploadId || !s3Key || !parts || !Array.isArray(parts) || parts.length === 0) {
            res.status(400).json({
                ok: false,
                error: 'Missing required fields: uploadId, s3Key, parts (array of {partNumber, etag})'
            })
            return
        }

        for (const part of parts) {
            if (!part.partNumber || !part.etag) {
                res.status(400).json({
                    ok: false,
                    error: 'Each part must have partNumber and etag'
                })
                return
            }
        }

        const sortedParts = parts
            .map(p => ({
                PartNumber: p.partNumber,
                ETag: p.etag.replace(/"/g, ''),
            }))
            .sort((a, b) => a.PartNumber - b.PartNumber)

        const completeCommand = new CompleteMultipartUploadCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: sortedParts.map(p => ({
                    PartNumber: p.PartNumber,
                    ETag: p.ETag,
                })),
            },
        })

        const completeResponse = await s3.send(completeCommand)

        uploadLogger.info({ s3Key, partsCount: parts.length, location: completeResponse.Location }, 'Chunked upload completed')

        res.json({
            ok: true,
            s3Key,
            bucket: s3Bucket,
            location: completeResponse.Location,
            etag: completeResponse.ETag,
        })

    } catch (error: any) {
        uploadLogger.error({ err: error }, 'Chunked upload complete failed')
        trackUploadError('complete_failed')
        res.status(500).json({ ok: false, error: 'Failed to complete upload', details: error.message })
    }
})

// 5. Abort chunked upload
app.post('/chunked-upload/abort', async (req: Request, res: Response): Promise<void> => {
    try {
        const { uploadId, s3Key } = req.body

        if (!uploadId || !s3Key) {
            res.status(400).json({
                ok: false,
                error: 'Missing required fields: uploadId, s3Key'
            })
            return
        }

        const abortCommand = new AbortMultipartUploadCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            UploadId: uploadId,
        })

        await s3.send(abortCommand)

        uploadLogger.info({ s3Key, uploadId }, 'Chunked upload aborted')

        res.json({ ok: true, message: 'Upload aborted successfully' })

    } catch (error: any) {
        uploadLogger.error({ err: error }, 'Chunked upload abort failed')
        res.status(500).json({ ok: false, error: 'Failed to abort upload', details: error.message })
    }
})

// =============================================================================
// FLEET DASHBOARD REST API
// =============================================================================

// Get all devices (fleet overview) - NOW WITH LOCK STATUS
app.get('/api/devices', (req: Request, res: Response) => {
    const deviceStatesMap = (global as any).deviceStates as Map<string, DeviceState> | undefined
    const devices = Array.from(deviceStatesMap?.values() ?? []).map((state) => ({
        deviceId: state.deviceId ?? 'unknown',
        isOnline: state.isOnline ?? false,
        lastSeen: state.lastSeen?.toISOString?.() ?? null,
        connectionTime: state.connectionTime?.toISOString?.() ?? null,
        telemetry: state.telemetry ?? null,
        // NEW: Lock status
        isLocked: !!state.lockedByTabletId,
        lockedByTabletId: state.lockedByTabletId ?? null
    }))

    res.json({
        ok: true,
        count: devices.length,
        devices
    })
})

// Get single device details
app.get('/api/devices/:deviceId', (req: Request, res: Response) => {
    const { deviceId } = req.params

    // Validate deviceId parameter
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > MAX_DEVICE_ID_LENGTH) {
        res.status(400).json({ ok: false, error: 'Invalid device ID' })
        return
    }

    const deviceStatesMap = (global as any).deviceStates as Map<string, DeviceState> | undefined
    const state = deviceStatesMap?.get(deviceId)

    if (!state) {
        res.status(404).json({ ok: false, error: 'Device not found' })
        return
    }

    res.json({
        ok: true,
        device: {
            deviceId: state.deviceId ?? deviceId,
            isOnline: state.isOnline ?? false,
            lastSeen: state.lastSeen?.toISOString?.() ?? null,
            connectionTime: state.connectionTime?.toISOString?.() ?? null,
            telemetry: state.telemetry ?? null,
            isLocked: !!state.lockedByTabletId,
            lockedByTabletId: state.lockedByTabletId ?? null
        }
    })
})

// Get device telemetry history (for charts)
app.get('/api/devices/:deviceId/history', (req: Request, res: Response) => {
    const { deviceId } = req.params

    // Validate deviceId parameter
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > MAX_DEVICE_ID_LENGTH) {
        res.status(400).json({ ok: false, error: 'Invalid device ID' })
        return
    }

    const telemetryHistoryMap = (global as any).telemetryHistory as Map<string, DeviceTelemetry[]> | undefined
    const history = telemetryHistoryMap?.get(deviceId) ?? []

    res.json({
        ok: true,
        deviceId,
        count: history.length,
        history
    })
})

// Set device custom name
app.post('/api/devices/:deviceId/name', (req: Request, res: Response) => {
    const { deviceId } = req.params

    // Validate deviceId parameter
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > MAX_DEVICE_ID_LENGTH) {
        res.status(400).json({ ok: false, error: 'Invalid device ID' })
        return
    }

    const { customName } = req.body

    // Validate customName
    if (customName !== undefined && (typeof customName !== 'string' || customName.length > 100)) {
        res.status(400).json({ ok: false, error: 'Invalid custom name (max 100 characters)' })
        return
    }

    const sanitizedName = typeof customName === 'string' ? customName : ''

    // Get or create device info in database
    let deviceDB = (global as any).deviceDB as Map<string, any> | undefined
    if (!deviceDB) {
        deviceDB = new Map()
        ;(global as any).deviceDB = deviceDB
    }

    let deviceInfo = deviceDB.get(deviceId)
    if (!deviceInfo) {
        deviceInfo = {
            deviceId,
            customName: sanitizedName,
            firstSeen: new Date().toISOString()
        }
    } else {
        deviceInfo.customName = sanitizedName
    }

    deviceDB.set(deviceId, deviceInfo)

    // Update device state if online
    const deviceStatesMap = (global as any).deviceStates as Map<string, DeviceState> | undefined
    const state = deviceStatesMap?.get(deviceId)
    if (state?.telemetry) {
        state.telemetry.customName = sanitizedName
    }

    fleetLogger.info({ deviceId, customName: sanitizedName }, 'Device renamed')
    res.json({ ok: true, customName: sanitizedName })
})

// Get fleet summary statistics - NOW WITH LOCKED COUNT
app.get('/api/fleet/summary', (_req: Request, res: Response) => {
    const deviceStatesMap = (global as any).deviceStates as Map<string, DeviceState> | undefined
    const states = Array.from(deviceStatesMap?.values() ?? [])

    const onlineStates = states.filter(s => s.isOnline === true)
    const offlineStates = states.filter(s => s.isOnline !== true)
    const recordingStates = states.filter(s => s.telemetry?.isRecording === true)
    const lowBatteryStates = onlineStates.filter(s => {
        const batteryLevel = s.telemetry?.batteryLevel
        return typeof batteryLevel === 'number' && batteryLevel < 0.25
    })
    const lockedStates = states.filter(s => !!s.lockedByTabletId)

    // Calculate average battery safely
    const batteryLevels = states
        .map(s => s.telemetry?.batteryLevel)
        .filter((level): level is number => typeof level === 'number' && !isNaN(level))
    const avgBatteryLevel = batteryLevels.length > 0
        ? batteryLevels.reduce((sum, level) => sum + level, 0) / batteryLevels.length
        : 0

    // Calculate total productive time safely
    const totalProductiveTime = states.reduce((sum, s) => {
        const productiveTime = s.telemetry?.productiveTime
        return sum + (typeof productiveTime === 'number' ? productiveTime : 0)
    }, 0)

    // Get unique app versions
    const appVersions = [...new Set(
        states
            .map(s => s.telemetry?.appVersion)
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
    )]

    const summary = {
        totalDevices: states.length,
        onlineDevices: onlineStates.length,
        offlineDevices: offlineStates.length,
        recordingDevices: recordingStates.length,
        lowBatteryDevices: lowBatteryStates.length,
        lockedDevices: lockedStates.length,
        avgBatteryLevel,
        totalProductiveTime,
        appVersions
    }

    res.json({ ok: true, summary })
})

// =============================================================================
// SESSION REST API
// =============================================================================

// Get all sessions
app.get('/api/sessions', (_req: Request, res: Response) => {
    const sessions = Array.from(captureSessions.values()).map(session => ({
        sessionId: session.sessionId,
        status: session.status,
        deviceCount: session.deviceIds.length,
        createdAt: session.createdAt.toISOString(),
        startedAt: session.startedAt?.toISOString(),
        endedAt: session.endedAt?.toISOString()
    }))

    res.json({ ok: true, count: sessions.length, sessions })
})

// Get session details
app.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const { sessionId } = req.params
    const session = captureSessions.get(sessionId)

    if (!session) {
        res.status(404).json({ ok: false, error: 'Session not found' })
        return
    }

    const deviceStatuses = Array.from(session.deviceStatuses.entries()).map(([deviceId, status]) => ({
        deviceId,
        ...status,
        deviceInfo: deviceStates.get(deviceId)?.telemetry
    }))

    res.json({
        ok: true,
        session: {
            sessionId: session.sessionId,
            status: session.status,
            deviceIds: session.deviceIds,
            deviceStatuses,
            createdAt: session.createdAt.toISOString(),
            startedAt: session.startedAt?.toISOString(),
            endedAt: session.endedAt?.toISOString(),
            metadata: session.metadata
        }
    })
})

// =============================================================================
// SOCKET.IO SETUP - OPTIMIZED FOR REAL-TIME LOW LATENCY
// =============================================================================

const server = http.createServer(app)

const io = new Server(server, {
    // CORS configuration (use same origins as REST API)
    cors: {
        origin: isDevelopment ? '*' : ALLOWED_ORIGINS,
        methods: ['GET', 'POST'],
        credentials: true
    },

    // === TRANSPORT OPTIMIZATION ===
    transports: ['websocket', 'polling'],
    allowUpgrades: true,

    // === TIMING OPTIMIZATION FOR REAL-TIME ===
    // Reduced ping interval for faster disconnect detection (was 10000/20000)
    pingInterval: SOCKET_PING_INTERVAL_MS,   // Default 5 seconds - detect disconnects faster
    pingTimeout: SOCKET_PING_TIMEOUT_MS,     // Default 10 seconds - total time before disconnect
    connectTimeout: SOCKET_CONNECT_TIMEOUT_MS, // Default 45 seconds

    // === BUFFER OPTIMIZATION ===
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE, // Default 100MB

    // === COMPRESSION - only for larger payloads ===
    perMessageDeflate: {
        threshold: 2048,
        zlibDeflateOptions: {
            chunkSize: 16 * 1024,
            level: 1,
        },
        zlibInflateOptions: {
            chunkSize: 16 * 1024,
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
    },
})

// === AUTHENTICATION MIDDLEWARE ===
io.use(socketAuthMiddleware)

// === MEMORY OPTIMIZATION ===
io.engine.on('connection', (rawSocket: any) => {
    rawSocket.request = null
})

// === STATE ===
const connectedHeadsets: Record<string, string> = {} // socket.id -> deviceId
const tabletHeadsetPairs: Record<string, string> = {} // tablet socket.id -> headset deviceId (LEGACY - single device)
const recordingHeadsets: string[] = [] // deviceIds

// === NEW: MULTI-DEVICE LOCKING STATE ===
// Map: tabletSocketId -> Set of deviceIds that tablet has locked
const tabletDeviceLocks: Map<string, Set<string>> = new Map()

// === LOCKING MUTEX FOR ATOMIC OPERATIONS ===
// Prevents race conditions when multiple tablets try to lock devices simultaneously

/** Whether a lock operation is currently in progress */
let lockingInProgress: boolean = false

/** Queue of pending lock operation resolvers */
const lockQueue: Array<() => void> = []

/**
 * Acquires the lock mutex for atomic device locking operations.
 *
 * This ensures that when multiple tablets try to lock devices simultaneously,
 * the operations are serialized to prevent race conditions where two tablets
 * could both think they acquired the same device.
 *
 * @returns Promise that resolves when the mutex is acquired
 *
 * @example
 * ```typescript
 * await acquireLockMutex()
 * try {
 *   // Perform atomic locking operations
 * } finally {
 *   releaseLockMutex()
 * }
 * ```
 */
async function acquireLockMutex(): Promise<void> {
    return new Promise((resolve) => {
        if (!lockingInProgress) {
            lockingInProgress = true
            resolve()
        } else {
            lockQueue.push(resolve)
        }
    })
}

/**
 * Releases the lock mutex, allowing the next queued operation to proceed.
 *
 * Must be called after every `acquireLockMutex()`, typically in a finally block
 * to ensure the mutex is always released even if an error occurs.
 */
function releaseLockMutex(): void {
    if (lockQueue.length > 0) {
        const next: (() => void) | undefined = lockQueue.shift()
        if (next) {
            next()
        }
    } else {
        lockingInProgress = false
    }
}

// =============================================================================
// SESSION MANAGEMENT FOR MULTI-QUEST CAPTURES
// =============================================================================

/**
 * Status of a single device within a capture session.
 */
interface DeviceSessionStatus {
    /** Whether the device is currently recording */
    isRecording: boolean
    /** Number of frames captured */
    frameCount: number
    /** Upload progress (0-100) */
    uploadProgress: number
    /** Current upload status */
    uploadStatus: 'pending' | 'uploading' | 'completed' | 'failed'
}

/**
 * Represents a multi-device capture session.
 *
 * Sessions coordinate recording across multiple Quest headsets
 * controlled by a single tablet.
 */
interface CaptureSession {
    /** Unique session identifier */
    sessionId: string
    /** Socket ID of the controlling tablet */
    tabletId: string
    /** Array of device IDs participating in this session */
    deviceIds: string[]
    /** Current session status */
    status: 'pending' | 'recording' | 'paused' | 'completed' | 'uploading'
    /** When the session was created */
    createdAt: Date
    /** When recording started (if started) */
    startedAt?: Date
    /** When the session ended (if ended) */
    endedAt?: Date
    /** Optional metadata for the session */
    metadata?: Record<string, unknown>
    /** Per-device status within the session */
    deviceStatuses: Map<string, DeviceSessionStatus>
}

const captureSessions: Map<string, CaptureSession> = new Map()
const tabletSessions: Map<string, string> = new Map() // tabletSocketId -> sessionId

// === FRAME BATCHING FOR REAL-TIME ===
const frameBatches: Map<string, string[]> = new Map()
const lastFrameTime: Map<string, number> = new Map()

// === HEADSET LIST CHANGE DETECTION ===
let lastHeadsetListJson = ''

// =============================================================================
// FLEET DASHBOARD - DEVICE TELEMETRY STATE
// =============================================================================

/**
 * Comprehensive telemetry data from a Quest headset.
 *
 * This data is sent periodically by headsets and used by the
 * fleet dashboard for monitoring device health and activity.
 */
interface DeviceTelemetry {
    /** Unique device identifier */
    deviceId: string
    /** Device hardware name */
    deviceName: string
    /** User-assigned custom name */
    customName?: string
    /** Unix timestamp of telemetry */
    timestamp: number
    /** Battery level (0-1) */
    batteryLevel: number
    /** Battery charging state */
    batteryState: number
    /** Storage used in bytes */
    storageUsedBytes: number
    /** Total storage in bytes */
    storageTotalBytes: number
    /** WiFi signal strength (dBm, typically -100 to 0) */
    wifiSignalLevel: number
    /** Connected WiFi network name */
    wifiSSID: string
    /** Application version string */
    appVersion: string
    /** Operating system version */
    osVersion: string
    /** SDK version */
    sdkVersion: string
    /** Whether left hand is being tracked */
    leftHandTracked: boolean
    /** Whether right hand is being tracked */
    rightHandTracked: boolean
    /** Whether body is being tracked */
    bodyTracked: boolean
    /** Tracking confidence (0-1) */
    trackingConfidence: number
    /** Whether device is currently recording */
    isRecording: boolean
    /** Current session duration in seconds */
    sessionDuration: number
    /** Total productive time in seconds */
    productiveTime: number
    /** Number of frames captured */
    frameCount: number
    /** Number of dropped frames */
    droppedFrames: number
    /** CPU temperature in Celsius */
    cpuTemperature: number
    /** GPU temperature in Celsius */
    gpuTemperature: number
    /** Memory used in MB */
    memoryUsedMB: number
    /** Total memory in MB */
    memoryTotalMB: number
}

/**
 * In-memory state for a connected device.
 *
 * Combines connection info, telemetry, and lock status.
 */
interface DeviceState {
    /** Unique device identifier */
    deviceId: string
    /** Current Socket.IO socket ID */
    socketId: string
    /** Whether the device is currently connected */
    isOnline: boolean
    /** Last activity timestamp */
    lastSeen: Date
    /** Latest telemetry data (null if not yet received) */
    telemetry: DeviceTelemetry | null
    /** When the device first connected in current session */
    connectionTime: Date
    /** Socket ID of tablet that has locked this device (if any) */
    lockedByTabletId?: string
    /** When the device was locked (if locked) */
    lockedAt?: Date
}

// In-memory device state (keyed by deviceId)
const deviceStates: Map<string, DeviceState> = new Map()

// Dashboard subscribers
const dashboardSubscribers: Set<string> = new Set()

// Telemetry history for charts
const telemetryHistory: Map<string, DeviceTelemetry[]> = new Map()
const TELEMETRY_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const TELEMETRY_HISTORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000
const lastHistorySample: Map<string, number> = new Map()

// Expose state to REST API
;(global as any).deviceStates = deviceStates
;(global as any).telemetryHistory = telemetryHistory

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Information about a headset for the device list.
 */
interface HeadsetListInfo {
    /** Unique device identifier */
    deviceId: string
    /** Whether the device is locked by a tablet */
    isLocked: boolean
    /** Socket ID of locking tablet (if locked) */
    lockedByTabletId: string | undefined
    /** User-assigned custom name */
    customName: string
}

/**
 * Lock status information for a device.
 */
interface DeviceLockStatus {
    /** Unique device identifier */
    deviceId: string
    /** Whether the device is locked by a tablet */
    isLocked: boolean
    /** Socket ID of locking tablet (if locked) */
    lockedByTabletId: string | undefined
}

/**
 * Broadcasts the current list of online headsets to all clients.
 *
 * Emits two events for compatibility:
 * - `on-headsets-with-lock-status-updated`: Full device info with lock status (new clients)
 * - `on-headsets-updated`: Simple array of device IDs (legacy clients)
 *
 * Uses change detection to avoid unnecessary broadcasts.
 */
function broadcastHeadsetList(): void {
    const onlineDevices: HeadsetListInfo[] = Array.from(deviceStates.values())
        .filter(state => state.isOnline)
        .map(state => ({
            deviceId: state.deviceId,
            isLocked: !!state.lockedByTabletId,
            lockedByTabletId: state.lockedByTabletId,
            customName: state.telemetry?.customName ?? ''
        }))

    // For NEW clients - send full HeadsetInfo objects with lock status
    const jsonNew: string = JSON.stringify(onlineDevices)
    if (jsonNew !== lastHeadsetListJson) {
        lastHeadsetListJson = jsonNew
        io.emit(SERVER_EVENTS.HEADSETS_WITH_LOCK_STATUS_UPDATED, onlineDevices)

        // For OLD clients - send just device IDs as simple string array
        const deviceIds: string[] = onlineDevices.map(d => d.deviceId)
        io.emit(SERVER_EVENTS.HEADSETS_UPDATED, deviceIds)
    }
}

/**
 * Broadcasts the current lock status of all online devices.
 *
 * Called after any device lock/unlock operation to keep
 * all tablets informed of device availability.
 */
function broadcastDeviceLockStatus(): void {
    const lockStatus: DeviceLockStatus[] = Array.from(deviceStates.values())
        .filter(state => state.isOnline)
        .map(state => ({
            deviceId: state.deviceId,
            isLocked: !!state.lockedByTabletId,
            lockedByTabletId: state.lockedByTabletId
        }))

    io.emit(SERVER_EVENTS.DEVICE_LOCKS_UPDATED, lockStatus)
}

// =============================================================================
// SOCKET.IO EVENT HANDLERS
// =============================================================================

io.on('connection', (socket: Socket) => {
    socketLogger.info({ socketId: socket.id }, 'Client connected')

    // Socket error handler
    socket.on('error', (error) => {
        socketLogger.error({ socketId: socket.id, error: error.message ?? error }, 'Socket error')
    })

    // === HEADSET EVENTS ===

    socket.on('headset-identify', (deviceId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'headset-identify')) return

        // Validate input
        if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 100) {
            socketLogger.warn({ socketId: socket.id }, 'Invalid deviceId received')
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            return
        }

        connectedHeadsets[socket.id] = deviceId
        socket.join(deviceId)
        socket.join('headsets') // Join headsets room for targeted broadcasts

        // Update or create device state
        let state = deviceStates.get(deviceId)
        const now = new Date()
        if (!state) {
            state = {
                deviceId,
                socketId: socket.id,
                isOnline: true,
                lastSeen: now,
                telemetry: null,
                connectionTime: now
            }
            deviceStates.set(deviceId, state)
        } else {
            state.socketId = socket.id
            state.isOnline = true
            state.lastSeen = now
        }

        // Persist device state to Redis (async, non-blocking)
        if (isRedisAvailable()) {
            redisSetDeviceState(deviceId, {
                deviceId,
                socketId: socket.id,
                isOnline: true,
                lastSeen: now.toISOString(),
                connectionTime: state.connectionTime.toISOString()
            }).catch(err => {
                serverLogger.warn({ err, deviceId }, 'Failed to persist device state to Redis')
            })
        }

        io.to(deviceId).emit('on-headset-connected')
        logDeviceConnect(deviceId, socket.id, 'headset')
        trackDeviceConnect('headset')
        trackSocketEvent('headset-identify')

        broadcastHeadsetList()
    })

    // Frame handling with throttling and rate limiting
    socket.on('headset-frame', (data: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'headset-frame')) return

        const headsetId = connectedHeadsets[socket.id]
        if (!headsetId) {
            socket.emit('error', { code: 'NOT_IDENTIFIED', message: 'Headset must identify first' })
            return
        }

        // Validate data size (prevent memory exhaustion)
        if (typeof data !== 'string' || data.length > 1024 * 1024) {
            socket.emit('error', { code: 'INVALID_FRAME_DATA', message: 'Frame data too large (max 1MB)' })
            return
        }

        const now = Date.now()
        const lastTime = lastFrameTime.get(socket.id) ?? 0

        if (now - lastTime < FRAME_THROTTLE_MS) return
        lastFrameTime.set(socket.id, now)

        let batch = frameBatches.get(headsetId)
        if (!batch) {
            batch = []
            frameBatches.set(headsetId, batch)
        }

        // Enforce frame batch size limit to prevent memory growth
        if (batch.length >= MAX_FRAME_BATCH_SIZE) {
            batch.shift() // Drop oldest frame
        }
        batch.push(data)
    })

    // Status updates (1fps)
    socket.on('headset-status', (data: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'headset-status')) return

        const headsetId = connectedHeadsets[socket.id]
        if (!headsetId) {
            socket.emit('error', { code: 'NOT_IDENTIFIED', message: 'Headset must identify first' })
            return
        }

        // Validate data size
        if (typeof data !== 'string' || data.length > 10000) {
            socket.emit('error', { code: 'INVALID_STATUS_DATA', message: 'Status data too large (max 10KB)' })
            return
        }

        io.to(headsetId).emit('on-headset-status-updated', data)
    })

    // Device telemetry for fleet dashboard
    socket.on('device-telemetry', (data: string | DeviceTelemetry) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'device-telemetry')) return

        try {
            // Handle both string (from Unity JsonUtility.ToJson) and object formats
            // Parse JSON, handling double-encoding from Unity
            let telemetry: any = data
            if (typeof telemetry === "string") telemetry = JSON.parse(telemetry)
            if (typeof telemetry === "string") telemetry = JSON.parse(telemetry) // Handle double-encoding
            const deviceId = telemetry.deviceId ?? connectedHeadsets[socket.id]

            if (!deviceId) {
                socket.emit('error', { code: 'INVALID_TELEMETRY', message: 'Missing deviceId in telemetry' })
                return
            }

            let state = deviceStates.get(deviceId)
            if (!state) {
                state = {
                    deviceId,
                    socketId: socket.id,
                    isOnline: true,
                    lastSeen: new Date(),
                    telemetry: null,
                    connectionTime: new Date()
                }
                deviceStates.set(deviceId, state)
            }

            const deviceInfo = (global as any).deviceDB?.get(deviceId)
            if (deviceInfo?.customName && telemetry) {
                telemetry.customName = deviceInfo.customName
            }

            state.telemetry = telemetry
            state.lastSeen = new Date()
            state.isOnline = true
            state.socketId = socket.id

            // Update battery level metric
            if (telemetry?.batteryLevel !== undefined) {
                updateBatteryLevel(deviceId, telemetry.batteryLevel * 100) // Convert 0-1 to 0-100
            }
            trackSocketEvent('device-telemetry')

            // Sample history
            const lastSample = lastHistorySample.get(deviceId) ?? 0
            const now = Date.now()
            if (now - lastSample >= TELEMETRY_HISTORY_SAMPLE_INTERVAL_MS) {
                let history = telemetryHistory.get(deviceId)
                if (!history) {
                    history = []
                    telemetryHistory.set(deviceId, history)
                }
                history.push({ ...telemetry })
                lastHistorySample.set(deviceId, now)

                const cutoff = now - TELEMETRY_HISTORY_MAX_AGE_MS
                telemetryHistory.set(deviceId, history.filter(t => t.timestamp > cutoff))
            }

            // Broadcast to dashboard subscribers
            if (dashboardSubscribers.size > 0) {
                const statePayload = {
                    deviceId,
                    isOnline: true,
                    lastSeen: state.lastSeen.toISOString(),
                    telemetry,
                    isLocked: !!state.lockedByTabletId,
                    lockedByTabletId: state.lockedByTabletId
                }
                dashboardSubscribers.forEach(subId => {
                    io.to(subId).emit('on-device-telemetry-updated', statePayload)
                })
            }
        } catch (e) {
            fleetLogger.error({ err: e }, 'Failed to parse device telemetry')
        }
    })

    // Dashboard subscription
    socket.on('dashboard-subscribe', () => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'dashboard-subscribe')) return

        dashboardSubscribers.add(socket.id)
        fleetLogger.info({ socketId: socket.id }, 'Dashboard subscribed')
        trackDashboardSubscribe()
        trackSocketEvent('dashboard-subscribe')

        const fleetStatus = Array.from(deviceStates.values()).map(state => ({
            deviceId: state.deviceId,
            isOnline: state.isOnline,
            lastSeen: state.lastSeen.toISOString(),
            connectionTime: state.connectionTime.toISOString(),
            telemetry: state.telemetry,
            isLocked: !!state.lockedByTabletId,
            lockedByTabletId: state.lockedByTabletId
        }))
        socket.emit('on-fleet-status-updated', fleetStatus)
    })

    socket.on('dashboard-unsubscribe', () => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'dashboard-unsubscribe')) return

        dashboardSubscribers.delete(socket.id)
        fleetLogger.info({ socketId: socket.id }, 'Dashboard unsubscribed')
        trackDashboardUnsubscribe()
        trackSocketEvent('dashboard-unsubscribe')
    })

    socket.on('headset-logs-processed', () => {
        if (socket.id in connectedHeadsets) {
            io.to(connectedHeadsets[socket.id]).emit('on-headset-logs-processed')
        }
    })

    socket.on('headset-recording-state', (recording: boolean) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'headset-recording-state')) return

        // Validate input
        if (typeof recording !== 'boolean') {
            socket.emit('error', { code: 'INVALID_INPUT', message: 'Recording state must be a boolean' })
            return
        }

        const headsetId = connectedHeadsets[socket.id]
        if (!headsetId) {
            socket.emit('error', { code: 'NOT_IDENTIFIED', message: 'Headset must identify first' })
            return
        }

        const idx = recordingHeadsets.indexOf(headsetId)
        if (idx !== -1) recordingHeadsets.splice(idx, 1)

        if (recording) recordingHeadsets.push(headsetId)

        // Legacy events (backwards compatibility)
        io.to(headsetId).emit(
            recording ? 'on-headset-recording-active' : 'on-headset-recording-inactive'
        )

        // NEW: Multi-device aware event with deviceId included
        io.to(headsetId).emit('on-device-recording-changed', { deviceId: headsetId, isRecording: recording })
        deviceLogger.info({ deviceId: headsetId, isRecording: recording }, 'Device recording state changed')
        trackSocketEvent('headset-recording-state')
    })

    // =========================================================================
    // MULTI-DEVICE TABLET EVENTS (NEW)
    // =========================================================================

    // Lock a device (exclusive control - prevents other tablets from using it)
    socket.on('tablet-lock-device', (deviceId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-lock-device')) return

        if (!isValidDeviceId(deviceId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            return
        }

        const state = deviceStates.get(deviceId)

        if (!state || !state.isOnline) {
            logDeviceLock(deviceId, socket.id, false, 'Device not online')
            trackDeviceLock(false)
            socket.emit('on-device-lock-failed', { deviceId, reason: 'Device not online' })
            return
        }

        if (state.lockedByTabletId && state.lockedByTabletId !== socket.id) {
            logDeviceLock(deviceId, socket.id, false, 'Device locked by another tablet')
            trackDeviceLock(false)
            socket.emit('on-device-lock-failed', { deviceId, reason: 'Device locked by another tablet' })
            return
        }

        // Lock the device
        state.lockedByTabletId = socket.id
        state.lockedAt = new Date()

        if (!tabletDeviceLocks.has(socket.id)) {
            tabletDeviceLocks.set(socket.id, new Set())
        }
        tabletDeviceLocks.get(socket.id)!.add(deviceId)

        socket.join(deviceId)

        logDeviceLock(deviceId, socket.id, true)
        trackDeviceLock(true)
        trackSocketEvent('tablet-lock-device')
        socket.emit('on-device-locked', { deviceId })
        broadcastDeviceLockStatus()
    })

    // Unlock a device
    socket.on('tablet-unlock-device', (deviceId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-unlock-device')) return

        if (!isValidDeviceId(deviceId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            return
        }

        const state = deviceStates.get(deviceId)

        if (state && state.lockedByTabletId === socket.id) {
            state.lockedByTabletId = undefined
            state.lockedAt = undefined

            tabletDeviceLocks.get(socket.id)?.delete(deviceId)
            socket.leave(deviceId)

            logDeviceUnlock(deviceId, socket.id)
            trackDeviceUnlock()
            trackSocketEvent('tablet-unlock-device')
            socket.emit('on-device-unlocked', { deviceId })
            broadcastDeviceLockStatus()
        }
    })

    // Lock multiple devices at once with validation, rate limiting, and mutex
    socket.on('tablet-lock-devices', async (deviceIds: string[]) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-lock-devices')) return

        // Validate input
        if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > MAX_DEVICES_PER_LOCK_REQUEST) {
            socketLogger.warn({ socketId: socket.id, deviceIdsLength: Array.isArray(deviceIds) ? deviceIds.length : 'not-array' }, 'Invalid device list in lock request')
            socket.emit('on-devices-locked', { locked: [], failed: [], error: 'Invalid device list' })
            return
        }

        // Validate each device ID
        for (const id of deviceIds) {
            if (typeof id !== 'string' || id.length === 0 || id.length > MAX_DEVICE_ID_LENGTH) {
                socketLogger.warn({ socketId: socket.id, invalidId: typeof id === 'string' ? id.substring(0, 20) : 'non-string' }, 'Invalid device ID format in lock request')
                socket.emit('on-devices-locked', { locked: [], failed: deviceIds, error: 'Invalid device ID format' })
                return
            }
        }

        // Acquire mutex to ensure atomic locking across concurrent requests
        await acquireLockMutex()

        try {
            const locked: string[] = []
            const failed: string[] = []

            // Atomic locking: validate all first, then lock all
            const toLock: string[] = []
            for (const deviceId of deviceIds) {
                const state = deviceStates.get(deviceId)

                if (!state || !state.isOnline) {
                    failed.push(deviceId)
                    continue
                }

                if (state.lockedByTabletId && state.lockedByTabletId !== socket.id) {
                    failed.push(deviceId)
                    continue
                }

                toLock.push(deviceId)
            }

            // Now lock all validated devices atomically (within mutex)
            for (const deviceId of toLock) {
                const state = deviceStates.get(deviceId)!
                state.lockedByTabletId = socket.id
                state.lockedAt = new Date()

                if (!tabletDeviceLocks.has(socket.id)) {
                    tabletDeviceLocks.set(socket.id, new Set())
                }
                tabletDeviceLocks.get(socket.id)!.add(deviceId)

                socket.join(deviceId)
                locked.push(deviceId)
            }

            deviceLogger.info({ lockedCount: locked.length, failedCount: failed.length, tabletId: socket.id }, 'Batch lock completed')
            trackSocketEvent('tablet-lock-devices')
            // Track each successful lock
            locked.forEach(() => trackDeviceLock(true))
            failed.forEach(() => trackDeviceLock(false))
            socket.emit('on-devices-locked', { locked, failed })
            broadcastDeviceLockStatus()
        } finally {
            // Always release mutex, even if error occurs
            releaseLockMutex()
        }
    })

    // Unlock all devices
    socket.on('tablet-unlock-all-devices', () => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-unlock-all-devices')) return

        const tabletLocks = tabletDeviceLocks.get(socket.id)
        const unlocked: string[] = []

        if (tabletLocks) {
            for (const deviceId of tabletLocks) {
                const state = deviceStates.get(deviceId)
                if (state) {
                    state.lockedByTabletId = undefined
                    state.lockedAt = undefined
                    socket.leave(deviceId)
                    unlocked.push(deviceId)
                }
            }
            tabletLocks.clear()
        }

        deviceLogger.info({ unlockedCount: unlocked.length, tabletId: socket.id }, 'All devices unlocked')
        trackSocketEvent('tablet-unlock-all-devices')
        unlocked.forEach(() => trackDeviceUnlock())
        socket.emit('on-all-devices-unlocked', { unlocked })
        broadcastDeviceLockStatus()
    })

    // Toggle recording for a specific locked device (DEPRECATED)
    socket.on('tablet-toggle-recording', (headsetId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-toggle-recording')) return

        socketLogger.warn({ socketId: socket.id }, '[DEPRECATED] Use tablet-start-recording or tablet-stop-recording instead')
        const state = deviceStates.get(headsetId)

        // For backwards compatibility, allow if no lock system or if this tablet has lock
        if (state?.lockedByTabletId && state.lockedByTabletId !== socket.id) {
            deviceLogger.warn({ deviceId: headsetId, tabletId: socket.id }, 'Recording toggle denied')
            socket.emit('on-recording-toggle-denied', { deviceId: headsetId })
            return
        }

        io.to(headsetId).emit('on-tablet-recording-toggled')
        deviceLogger.info({ deviceId: headsetId, tabletId: socket.id }, 'Tablet toggled recording')
        trackSocketEvent('tablet-toggle-recording')
    })

    // Toggle recording for ALL locked devices (DEPRECATED)
    socket.on('tablet-toggle-all-recording', () => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-toggle-all-recording')) return

        socketLogger.warn({ socketId: socket.id }, '[DEPRECATED] Use tablet-start-all-recording or tablet-stop-all-recording instead')
        const tabletLocks = tabletDeviceLocks.get(socket.id)
        if (!tabletLocks || tabletLocks.size === 0) {
            deviceLogger.debug({ tabletId: socket.id }, 'Toggle all: No devices locked')
            return
        }

        for (const deviceId of tabletLocks) {
            io.to(deviceId).emit('on-tablet-recording-toggled')
        }
        deviceLogger.info({ tabletId: socket.id, deviceCount: tabletLocks.size }, 'Toggled recording for all devices')
        trackSocketEvent('tablet-toggle-all-recording')
    })

    // =========================================================================
    // EXPLICIT START/STOP RECORDING EVENTS (Preferred over toggle)
    // =========================================================================

    // Start recording for a specific device (with optional ACK callback)
    socket.on('tablet-start-recording', (deviceId: string, callback?: (response: { success: boolean; error?: string; deviceId?: string }) => void) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-start-recording')) {
            if (callback) callback({ success: false, error: 'Rate limited', deviceId })
            return
        }

        // Validate input
        if (!isValidDeviceId(deviceId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            if (callback) callback({ success: false, error: 'Invalid device ID format', deviceId })
            return
        }

        const state = deviceStates.get(deviceId)
        if (state?.lockedByTabletId && state.lockedByTabletId !== socket.id) {
            socket.emit('on-recording-denied', { deviceId })
            if (callback) callback({ success: false, error: 'Device locked by another tablet', deviceId })
            return
        }

        // Check if device is online
        if (!state?.isOnline) {
            if (callback) callback({ success: false, error: 'Device offline', deviceId })
            return
        }

        // Only start if not already recording
        const isRecording = recordingHeadsets.includes(deviceId)
        if (!isRecording) {
            io.to(deviceId).emit('on-tablet-start-recording')
            deviceLogger.info({ deviceId, tabletId: socket.id }, 'Tablet started recording for device')
            trackSocketEvent('tablet-start-recording')
            if (callback) callback({ success: true, deviceId })
        } else {
            // Already recording - still consider it a success
            if (callback) callback({ success: true, deviceId })
        }
    })

    // Stop recording for a specific device (with optional ACK callback)
    socket.on('tablet-stop-recording', (deviceId: string, callback?: (response: { success: boolean; error?: string; deviceId?: string }) => void) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-stop-recording')) {
            if (callback) callback({ success: false, error: 'Rate limited', deviceId })
            return
        }

        // Validate input
        if (!isValidDeviceId(deviceId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            if (callback) callback({ success: false, error: 'Invalid device ID format', deviceId })
            return
        }

        const state = deviceStates.get(deviceId)
        if (state?.lockedByTabletId && state.lockedByTabletId !== socket.id) {
            socket.emit('on-recording-denied', { deviceId })
            if (callback) callback({ success: false, error: 'Device locked by another tablet', deviceId })
            return
        }

        // Check if device is online
        if (!state?.isOnline) {
            if (callback) callback({ success: false, error: 'Device offline', deviceId })
            return
        }

        // Only stop if currently recording
        const isRecording = recordingHeadsets.includes(deviceId)
        if (isRecording) {
            io.to(deviceId).emit('on-tablet-stop-recording')
            deviceLogger.info({ deviceId, tabletId: socket.id }, 'Tablet stopped recording for device')
            trackSocketEvent('tablet-stop-recording')
            if (callback) callback({ success: true, deviceId })
        } else {
            // Not recording - still consider it a success
            if (callback) callback({ success: true, deviceId })
        }
    })

    // Start recording for ALL locked devices (with optional ACK callback)
    socket.on('tablet-start-all-recording', (callback?: (response: { success: boolean; results: Record<string, { success: boolean; error?: string }>; startedCount: number; totalDevices: number }) => void) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-start-all-recording')) {
            if (callback) callback({ success: false, results: {}, startedCount: 0, totalDevices: 0 })
            return
        }

        const tabletLocks = tabletDeviceLocks.get(socket.id)
        if (!tabletLocks || tabletLocks.size === 0) {
            deviceLogger.debug({ tabletId: socket.id }, 'Start all: No devices locked')
            if (callback) callback({ success: true, results: {}, startedCount: 0, totalDevices: 0 })
            return
        }

        let startedCount = 0
        const results: Record<string, { success: boolean; error?: string }> = {}

        for (const deviceId of tabletLocks) {
            const state = deviceStates.get(deviceId)
            if (!state?.isOnline) {
                results[deviceId] = { success: false, error: 'Device offline' }
                continue
            }

            const isRecording = recordingHeadsets.includes(deviceId)
            if (!isRecording) {
                io.to(deviceId).emit('on-tablet-start-recording')
                startedCount++
                results[deviceId] = { success: true }
            } else {
                // Already recording - still consider it a success
                results[deviceId] = { success: true }
            }
        }
        deviceLogger.info({ tabletId: socket.id, startedCount, totalDevices: tabletLocks.size }, 'Started recording for all devices')
        trackSocketEvent('tablet-start-all-recording')

        if (callback) callback({ success: true, results, startedCount, totalDevices: tabletLocks.size })
    })

    // Stop recording for ALL locked devices (with optional ACK callback)
    socket.on('tablet-stop-all-recording', (callback?: (response: { success: boolean; results: Record<string, { success: boolean; error?: string }>; stoppedCount: number; totalDevices: number }) => void) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-stop-all-recording')) {
            if (callback) callback({ success: false, results: {}, stoppedCount: 0, totalDevices: 0 })
            return
        }

        const tabletLocks = tabletDeviceLocks.get(socket.id)
        if (!tabletLocks || tabletLocks.size === 0) {
            deviceLogger.debug({ tabletId: socket.id }, 'Stop all: No devices locked')
            if (callback) callback({ success: true, results: {}, stoppedCount: 0, totalDevices: 0 })
            return
        }

        let stoppedCount = 0
        const results: Record<string, { success: boolean; error?: string }> = {}

        for (const deviceId of tabletLocks) {
            const state = deviceStates.get(deviceId)
            if (!state?.isOnline) {
                results[deviceId] = { success: false, error: 'Device offline' }
                continue
            }

            const isRecording = recordingHeadsets.includes(deviceId)
            if (isRecording) {
                io.to(deviceId).emit('on-tablet-stop-recording')
                stoppedCount++
                results[deviceId] = { success: true }
            } else {
                // Not recording - still consider it a success
                results[deviceId] = { success: true }
            }
        }
        deviceLogger.info({ tabletId: socket.id, stoppedCount, totalDevices: tabletLocks.size }, 'Stopped recording for all devices')
        trackSocketEvent('tablet-stop-all-recording')

        if (callback) callback({ success: true, results, stoppedCount, totalDevices: tabletLocks.size })
    })

    // =========================================================================
    // SESSION MANAGEMENT EVENTS
    // =========================================================================

    // Create a new capture session with selected devices
    socket.on('tablet-create-session', (data: { deviceIds: string[], metadata?: Record<string, unknown> }) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-create-session')) return

        // Validate input structure
        if (!data || typeof data !== 'object') {
            socket.emit('on-session-error', { error: 'Invalid request format' })
            return
        }

        const { deviceIds, metadata } = data

        if (!deviceIds || deviceIds.length === 0) {
            socket.emit('on-session-error', { error: 'No devices specified' })
            return
        }

        // Validate all devices are available
        const unavailable: string[] = []
        const available: string[] = []

        for (const deviceId of deviceIds) {
            const state = deviceStates.get(deviceId)
            if (!state || !state.isOnline) {
                unavailable.push(deviceId)
            } else if (state.lockedByTabletId && state.lockedByTabletId !== socket.id) {
                unavailable.push(deviceId)
            } else {
                available.push(deviceId)
            }
        }

        if (available.length === 0) {
            socket.emit('on-session-error', {
                error: 'No available devices',
                unavailable
            })
            return
        }

        // Generate session ID
        const sessionId = `session_${Date.now()}_${socket.id.slice(0, 6)}`

        // Create session
        const session: CaptureSession = {
            sessionId,
            tabletId: socket.id,
            deviceIds: available,
            status: 'pending',
            createdAt: new Date(),
            metadata,
            deviceStatuses: new Map()
        }

        // Initialize device statuses
        for (const deviceId of available) {
            session.deviceStatuses.set(deviceId, {
                isRecording: false,
                frameCount: 0,
                uploadProgress: 0,
                uploadStatus: 'pending'
            })
        }

        captureSessions.set(sessionId, session)
        tabletSessions.set(socket.id, sessionId)

        // Lock all devices in session
        for (const deviceId of available) {
            const state = deviceStates.get(deviceId)
            if (state) {
                state.lockedByTabletId = socket.id
                state.lockedAt = new Date()

                if (!tabletDeviceLocks.has(socket.id)) {
                    tabletDeviceLocks.set(socket.id, new Set())
                }
                tabletDeviceLocks.get(socket.id)!.add(deviceId)
                socket.join(deviceId)
            }
        }

        logSession(sessionId, 'created', available.length, { unavailable: unavailable.length })
        trackSessionCreated()
        trackSocketEvent('tablet-create-session')

        socket.emit('on-session-created', {
            sessionId,
            deviceIds: available,
            unavailable: unavailable.length > 0 ? unavailable : undefined
        })

        broadcastDeviceLockStatus()
    })

    // Start recording for all session devices
    socket.on('tablet-start-session', (sessionId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-start-session')) return

        // Validate input
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 100) {
            socket.emit('on-session-error', { error: 'Invalid session ID format' })
            return
        }

        const session = captureSessions.get(sessionId)

        if (!session) {
            socket.emit('on-session-error', { error: 'Session not found', sessionId })
            return
        }

        if (session.tabletId !== socket.id) {
            socket.emit('on-session-error', { error: 'Not authorized', sessionId })
            return
        }

        session.status = 'recording'
        session.startedAt = new Date()

        // Send start command to all devices
        for (const deviceId of session.deviceIds) {
            io.to(deviceId).emit('on-tablet-recording-toggled')
            const deviceStatus = session.deviceStatuses.get(deviceId)
            if (deviceStatus) {
                deviceStatus.isRecording = true
            }
        }

        logSession(sessionId, 'started', session.deviceIds.length)
        trackSocketEvent('tablet-start-session')
        socket.emit('on-session-started', { sessionId, startedAt: session.startedAt.toISOString() })
    })

    // Pause session recording
    socket.on('tablet-pause-session', (sessionId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-pause-session')) return

        // Validate input
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 100) {
            socket.emit('on-session-error', { error: 'Invalid session ID format' })
            return
        }

        const session = captureSessions.get(sessionId)

        if (!session || session.tabletId !== socket.id) {
            socket.emit('on-session-error', { error: 'Invalid session', sessionId })
            return
        }

        session.status = 'paused'

        for (const deviceId of session.deviceIds) {
            io.to(deviceId).emit('on-tablet-recording-toggled')
            const deviceStatus = session.deviceStatuses.get(deviceId)
            if (deviceStatus) {
                deviceStatus.isRecording = false
            }
        }

        logSession(sessionId, 'paused', session.deviceIds.length)
        trackSocketEvent('tablet-pause-session')
        socket.emit('on-session-paused', { sessionId })
    })

    // End session
    socket.on('tablet-end-session', (sessionId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-end-session')) return

        // Validate input
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 100) {
            socket.emit('on-session-error', { error: 'Invalid session ID format' })
            return
        }

        const session = captureSessions.get(sessionId)

        if (!session || session.tabletId !== socket.id) {
            socket.emit('on-session-error', { error: 'Invalid session', sessionId })
            return
        }

        session.status = 'completed'
        session.endedAt = new Date()

        // Stop recording on all devices
        for (const deviceId of session.deviceIds) {
            io.to(deviceId).emit('on-session-ended', { sessionId })
            const deviceStatus = session.deviceStatuses.get(deviceId)
            if (deviceStatus) {
                deviceStatus.isRecording = false
            }
        }

        tabletSessions.delete(socket.id)

        const durationSeconds = session.startedAt
            ? Math.round((session.endedAt!.getTime() - session.startedAt.getTime()) / 1000)
            : 0
        logSession(sessionId, 'ended', session.deviceIds.length, { durationSeconds })
        trackSessionCompleted(durationSeconds)
        trackSocketEvent('tablet-end-session')
        socket.emit('on-session-ended', {
            sessionId,
            endedAt: session.endedAt.toISOString(),
            duration: session.startedAt
                ? Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 1000)
                : 0
        })
    })

    // Get session status
    socket.on('tablet-get-session', (sessionId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-get-session')) return

        // Validate input
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 100) {
            socket.emit('on-session-error', { error: 'Invalid session ID format' })
            return
        }

        const session = captureSessions.get(sessionId)

        if (!session) {
            socket.emit('on-session-error', { error: 'Session not found', sessionId })
            return
        }

        const deviceStatuses = Array.from(session.deviceStatuses.entries()).map(([deviceId, status]) => ({
            deviceId,
            ...status
        }))

        socket.emit('on-session-status', {
            sessionId: session.sessionId,
            status: session.status,
            deviceIds: session.deviceIds,
            deviceStatuses,
            createdAt: session.createdAt.toISOString(),
            startedAt: session.startedAt?.toISOString(),
            endedAt: session.endedAt?.toISOString()
        })
    })

    // Get active session for this tablet
    socket.on('tablet-get-active-session', () => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-get-active-session')) return

        const sessionId = tabletSessions.get(socket.id)
        if (sessionId) {
            const session = captureSessions.get(sessionId)
            if (session) {
                socket.emit('on-active-session', {
                    sessionId: session.sessionId,
                    status: session.status,
                    deviceIds: session.deviceIds
                })
                return
            }
        }
        socket.emit('on-active-session', null)
    })

    // LEGACY: Single device connection (backwards compatible)
    socket.on('tablet-connect-headset', (headsetId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-connect-headset')) return

        // Validate input
        if (!isValidDeviceId(headsetId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            return
        }

        socket.join(headsetId)
        tabletHeadsetPairs[socket.id] = headsetId

        // Also try to lock the device
        const state = deviceStates.get(headsetId)
        if (state && !state.lockedByTabletId) {
            state.lockedByTabletId = socket.id
            state.lockedAt = new Date()
            if (!tabletDeviceLocks.has(socket.id)) {
                tabletDeviceLocks.set(socket.id, new Set())
            }
            tabletDeviceLocks.get(socket.id)!.add(headsetId)
            broadcastDeviceLockStatus()
        }

        socketLogger.info({ tabletId: socket.id, headsetId }, 'Tablet connected to headset (legacy)')
        trackDeviceConnect('tablet')
        trackSocketEvent('tablet-connect-headset')
    })

    socket.on('tablet-disconnect-headset', (headsetId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-disconnect-headset')) return

        // Validate input
        if (!isValidDeviceId(headsetId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            return
        }

        socket.leave(headsetId)
        delete tabletHeadsetPairs[socket.id]

        // Also unlock the device
        const state = deviceStates.get(headsetId)
        if (state && state.lockedByTabletId === socket.id) {
            state.lockedByTabletId = undefined
            state.lockedAt = undefined
            tabletDeviceLocks.get(socket.id)?.delete(headsetId)
            broadcastDeviceLockStatus()
        }

        socketLogger.info({ tabletId: socket.id, headsetId }, 'Tablet disconnected from headset (legacy)')
        trackDeviceDisconnect('tablet')
        trackSocketEvent('tablet-disconnect-headset')
    })

    socket.on('tablet-get-recording-status', (headsetId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-get-recording-status')) return

        // Validate input
        if (!isValidDeviceId(headsetId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid device ID format' })
            return
        }

        const recording = recordingHeadsets.indexOf(headsetId) !== -1
        socket.emit(recording ? 'on-recording-active' : 'on-recording-inactive')
    })

    socket.on('tablet-sync-metadata', (data: string, targetDeviceId?: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-sync-metadata')) return

        // Validate data size (prevent memory exhaustion)
        if (typeof data !== 'string' || data.length > 100000) {
            socket.emit('error', { code: 'INVALID_METADATA', message: 'Metadata too large (max 100KB)' })
            return
        }

        // Validate targetDeviceId if provided
        if (targetDeviceId !== undefined && !isValidDeviceId(targetDeviceId)) {
            socket.emit('error', { code: 'INVALID_DEVICE_ID', message: 'Invalid target device ID format' })
            return
        }

        if (targetDeviceId) {
            io.to(targetDeviceId).emit('on-tablet-metadata-synced', data)
        } else {
            // Legacy: send to paired headset
            const headsetId = tabletHeadsetPairs[socket.id]
            if (headsetId) {
                io.to(headsetId).emit('on-tablet-metadata-synced', data)
            }
            // Also send to all locked devices
            const locks = tabletDeviceLocks.get(socket.id)
            if (locks) {
                for (const deviceId of locks) {
                    io.to(deviceId).emit('on-tablet-metadata-synced', data)
                }
            }
        }
    })

    // === DISCONNECT HANDLING ===

    socket.on('disconnect', (reason: string) => {
        socketLogger.info({ socketId: socket.id, reason }, 'Client disconnected')

        // Cleanup rate limit tracking for this socket
        cleanupSocketRateLimit(socket.id)

        // Clean up tablet session association
        const sessionId = tabletSessions.get(socket.id)
        if (sessionId) {
            const session = captureSessions.get(sessionId)
            if (session && session.tabletId === socket.id && session.status !== 'completed') {
                // Mark session as ended if tablet disconnects during active session
                session.status = 'completed'
                session.endedAt = new Date()
                sessionLogger.warn({ sessionId, tabletId: socket.id, reason }, 'Session ended due to tablet disconnect')
            }
            tabletSessions.delete(socket.id)
        }

        // Release all device locks held by this tablet
        const tabletLocks = tabletDeviceLocks.get(socket.id)
        if (tabletLocks && tabletLocks.size > 0) {
            const unlockedDevices: string[] = []
            for (const deviceId of tabletLocks) {
                const state = deviceStates.get(deviceId)
                if (state && state.lockedByTabletId === socket.id) {
                    state.lockedByTabletId = undefined
                    state.lockedAt = undefined
                    unlockedDevices.push(deviceId)
                    trackDeviceUnlock()
                }
            }
            tabletDeviceLocks.delete(socket.id)
            if (unlockedDevices.length > 0) {
                deviceLogger.info({ tabletId: socket.id, unlockedCount: unlockedDevices.length, deviceIds: unlockedDevices }, 'Released device locks on disconnect')
                broadcastDeviceLockStatus()
            }
        }

        // Clean up legacy tablet pair
        if (socket.id in tabletHeadsetPairs) {
            delete tabletHeadsetPairs[socket.id]
        }

        // Handle headset disconnect
        if (socket.id in connectedHeadsets) {
            const headsetId = connectedHeadsets[socket.id]
            io.to(headsetId).emit('on-headset-disconnected')
            delete connectedHeadsets[socket.id]
            lastFrameTime.delete(socket.id)
            frameBatches.delete(headsetId)

            // Clean up history sample tracking for this device
            lastHistorySample.delete(headsetId)

            // Clean up recordingHeadsets to prevent memory leak
            const recordingIdx = recordingHeadsets.indexOf(headsetId)
            if (recordingIdx !== -1) {
                recordingHeadsets.splice(recordingIdx, 1)
            }

            // Mark device offline
            const state = deviceStates.get(headsetId)
            if (state) {
                state.isOnline = false
                state.lastSeen = new Date()

                // Persist offline state to Redis (async, non-blocking)
                if (isRedisAvailable()) {
                    redisMarkDeviceOffline(headsetId).catch(err => {
                        serverLogger.warn({ err, deviceId: headsetId }, 'Failed to mark device offline in Redis')
                    })
                }

                // Release any locks on this device
                if (state.lockedByTabletId) {
                    const lockingTablet = state.lockedByTabletId
                    state.lockedByTabletId = undefined
                    state.lockedAt = undefined
                    tabletDeviceLocks.get(lockingTablet)?.delete(headsetId)
                    io.to(lockingTablet).emit('on-device-disconnected', { deviceId: headsetId })
                    broadcastDeviceLockStatus()
                }

                // Notify dashboard
                if (dashboardSubscribers.size > 0) {
                    const offlinePayload = {
                        deviceId: headsetId,
                        isOnline: false,
                        lastSeen: state.lastSeen.toISOString(),
                        telemetry: state.telemetry
                    }
                    dashboardSubscribers.forEach(subId => {
                        io.to(subId).emit('on-device-telemetry-updated', offlinePayload)
                    })
                }
            }

            logDeviceDisconnect(headsetId, socket.id, reason)
            trackDeviceDisconnect('headset')
        }

        dashboardSubscribers.delete(socket.id)
        broadcastHeadsetList()
    })
})

// =============================================================================
// PERIODIC TASKS
// =============================================================================

/** Timestamp of the last frame batch emission */
let lastBatchEmission: number = Date.now()

/**
 * Calculates the optimal frame emission interval based on current load.
 *
 * Adapts the frame rate based on the number of active watchers:
 * - 0 watchers: 1 fps (conserve resources)
 * - 1 watcher: 30 fps (full quality)
 * - 2-3 watchers: 20 fps
 * - 4-10 watchers: 10 fps
 * - 10+ watchers: 5 fps (scale gracefully)
 *
 * @returns Interval in milliseconds between frame batch emissions
 */
function calculateDynamicFrameInterval(): number {
    // Adapt frame rate based on number of watchers (tablets/dashboards)
    const watcherCount: number = dashboardSubscribers.size + tabletDeviceLocks.size

    if (watcherCount === 0) return 1000 // 1fps if nobody watching (save resources)
    if (watcherCount === 1) return 33   // 30fps for single watcher
    if (watcherCount <= 3) return 50    // 20fps for few watchers
    if (watcherCount <= 10) return 100  // 10fps for multiple watchers
    return 200                          // 5fps for many watchers (scale gracefully)
}

// Store interval references for cleanup during graceful shutdown
const intervals: NodeJS.Timeout[] = []

// Batch frame emission with adaptive throttling
intervals.push(setInterval(() => {
    const now = Date.now()
    const dynamicInterval = calculateDynamicFrameInterval()

    // Skip emission if not enough time has passed (adaptive throttle)
    if (now - lastBatchEmission < dynamicInterval) return
    lastBatchEmission = now

    for (const [headsetId, batch] of frameBatches) {
        if (batch.length === 0) continue

        // Only emit if there are actual watchers in the room
        const room = io.sockets.adapter.rooms.get(headsetId)
        const watcherCount = room?.size ?? 0

        // Skip if only the headset itself is in the room (no tablet watching)
        if (watcherCount <= 1) {
            frameBatches.set(headsetId, []) // Clear batch to prevent memory buildup
            continue
        }

        // Send only the latest frame to reduce bandwidth
        const latestFrame = batch[batch.length - 1]
        io.to(headsetId).emit('on-headset-frame-updated', latestFrame)
        frameBatches.set(headsetId, [])
    }
}, 16)) // Check frequently (60Hz), but emit at dynamic rate

// Broadcast headset list periodically
intervals.push(setInterval(() => {
    broadcastHeadsetList()
}, CONNECTED_HEADSETS_BROADCAST_FREQUENCY))

// =============================================================================
// MEMORY CLEANUP TASKS
// =============================================================================

// Clean up expired sessions (completed sessions older than 24h)
intervals.push(setInterval(() => {
    const now = Date.now()
    let cleanedCount = 0

    for (const [sessionId, session] of captureSessions) {
        if (session.status === 'completed' && session.endedAt) {
            const sessionAge = now - session.endedAt.getTime()
            if (sessionAge > SESSION_EXPIRY_MS) {
                captureSessions.delete(sessionId)
                cleanedCount++
            }
        }
    }

    if (cleanedCount > 0) {
        serverLogger.info({ cleanedCount }, 'Removed expired sessions')
    }
}, SESSION_CLEANUP_INTERVAL_MS))

// Clean up offline devices not seen for extended period
intervals.push(setInterval(() => {
    const now = Date.now()
    let cleanedCount = 0

    for (const [deviceId, state] of deviceStates) {
        if (!state.isOnline && state.lastSeen) {
            const offlineDuration = now - state.lastSeen.getTime()
            if (offlineDuration > OFFLINE_DEVICE_EXPIRY_MS) {
                deviceStates.delete(deviceId)
                telemetryHistory.delete(deviceId)
                lastHistorySample.delete(deviceId)
                cleanedCount++
            }
        }
    }

    if (cleanedCount > 0) {
        serverLogger.info({ cleanedCount }, 'Removed stale offline devices')
    }
}, SESSION_CLEANUP_INTERVAL_MS))

// Clean up orphaned telemetry history (devices no longer in deviceStates)
intervals.push(setInterval(() => {
    let cleanedCount = 0

    for (const deviceId of telemetryHistory.keys()) {
        if (!deviceStates.has(deviceId)) {
            telemetryHistory.delete(deviceId)
            lastHistorySample.delete(deviceId)
            cleanedCount++
        }
    }

    if (cleanedCount > 0) {
        serverLogger.info({ cleanedCount }, 'Removed orphaned telemetry histories')
    }
}, TELEMETRY_HISTORY_CLEANUP_INTERVAL_MS))

// =============================================================================
// START SERVER
// =============================================================================

/**
 * Initializes and starts the server.
 *
 * This function:
 * 1. Initializes Redis connection (optional, falls back to in-memory)
 * 2. Configures Socket.IO Redis adapter for horizontal scaling (if enabled)
 * 3. Sets up graceful shutdown handlers
 * 4. Starts the HTTP server
 *
 * @throws Will exit process with code 1 if server fails to start
 */
async function startServer(): Promise<void> {
    // Initialize Redis (optional - falls back to in-memory if unavailable)
    const redisAvailable = await initRedis().catch(err => {
        serverLogger.warn({ err }, 'Redis not available, using in-memory state only')
        return false
    })

    // Configure Socket.IO Redis Streams adapter for horizontal scaling
    // Only enable if Redis is available and REDIS_ADAPTER env var is set
    if (redisAvailable && process.env.REDIS_ADAPTER === 'true') {
        const redisClient = getRedisClient()
        if (redisClient) {
            try {
                io.adapter(createAdapter(redisClient, {
                    // Stream name for Socket.IO events
                    streamName: 'socket.io',
                    // Maximum stream size (MAXLEN)
                    maxLen: 10000,
                }))
                serverLogger.info('Socket.IO Redis Streams adapter configured for horizontal scaling')
            } catch (err) {
                serverLogger.warn({ err }, 'Failed to configure Redis adapter, running without horizontal scaling')
            }
        }
    }

    // Graceful shutdown handler - properly await all cleanup operations
    const gracefulShutdown = async (signal: string) => {
        serverLogger.info({ signal }, 'Received shutdown signal, closing gracefully...')

        // Clear all intervals to prevent further processing
        intervals.forEach(clearInterval)
        serverLogger.info({ intervalCount: intervals.length }, 'Cleared all intervals')

        // Close Socket.IO connections and await completion
        await new Promise<void>((resolve) => {
            io.close(() => {
                serverLogger.info('Socket.IO server closed')
                resolve()
            })
        })

        // Close HTTP server and await completion
        await new Promise<void>((resolve) => {
            server.close(() => {
                serverLogger.info('HTTP server closed')
                resolve()
            })
        })

        // Shutdown Redis connection
        if (isRedisAvailable()) {
            await shutdownRedis()
        }

        process.exit(0)
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
    process.on('SIGINT', () => gracefulShutdown('SIGINT'))

    // Global error handlers for uncaught exceptions and unhandled rejections
    process.on('uncaughtException', (err: Error) => {
        serverLogger.fatal({ err, stack: err.stack }, 'Uncaught exception - server will exit')
        // Give time for logs to flush before exiting
        setTimeout(() => process.exit(1), 1000)
    })

    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
        serverLogger.error({ reason, promise: String(promise) }, 'Unhandled promise rejection')
        // Don't exit on unhandled rejection, but log it for monitoring
    })

    server.listen(PORT, HOST, () => {
        serverLogger.info({
            port: PORT,
            host: HOST,
            s3Bucket,
            environment: isDevelopment ? 'development' : 'production',
            redisEnabled: redisAvailable,
            redisAdapter: redisAvailable && process.env.REDIS_ADAPTER === 'true',
            config: {
                socketPingInterval: SOCKET_PING_INTERVAL_MS,
                socketPingTimeout: SOCKET_PING_TIMEOUT_MS,
                frameBatchInterval: FRAME_BATCH_INTERVAL_MS,
                maxDevicesPerLockRequest: MAX_DEVICES_PER_LOCK_REQUEST,
                sessionExpiryMs: SESSION_EXPIRY_MS
            },
            features: [
                'Multi-device tablet control',
                'Device locking (prevents conflicts)',
                'Real-time optimization',
                'Chunked uploads (20GB max)',
                'Rate limiting & validation',
                'JWT authentication',
                'Prometheus metrics (/metrics)',
                'Structured logging (pino)',
                redisAvailable ? 'Redis state persistence' : 'In-memory state only',
                redisAvailable && process.env.REDIS_ADAPTER === 'true' ? 'Redis Streams adapter (horizontal scaling)' : 'Single-node mode'
            ]
        }, 'Turing Backend v2.5 started - Secure Multi-Device with Enhanced Validation')
    })
}

// Start the server
startServer().catch(err => {
    serverLogger.fatal({ err }, 'Failed to start server')
    process.exit(1)
})
