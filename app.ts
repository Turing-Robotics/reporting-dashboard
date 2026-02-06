import 'dotenv/config'

import express, { Request, Response, Router } from 'express'
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
import { socketAuthMiddleware, createAuthRouter, adminAuthMiddleware, AuthenticatedSocket } from './auth'
import { apiLimiter, uploadLimiter, authLimiter, healthLimiter, checkSocketRateLimit, cleanupSocketRateLimit } from './rateLimiter'
import { validate, lockDevicesSchema, createSessionSchema, deviceTelemetrySchema, headsetIdentifySchema, withValidation } from './validation'

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
    logUpload,
    logTelemetry,
    logSocketEvent,
    logError,
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
    trackUploadComplete,
    trackUploadBytes,
    trackUploadError,
    trackSocketEvent,
    trackSocketMessage,
    trackFrameBatch,
    trackFrameDropped,
    trackDashboardSubscribe,
    trackDashboardUnsubscribe,
    updateBatteryLevel,
    updateLowBatteryCount,
    updateDeviceCounts,
    connectedDevices,
    recordingDevices as recordingDevicesMetric
} from './metrics'

import multerS3 from 'multer-s3'

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONNECTED_HEADSETS_BROADCAST_FREQUENCY = 1000
const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB per chunk
const MAX_CHUNKS = 10000 // S3 limit
const PRESIGNED_URL_EXPIRY = 3600 // 1 hour

// === REAL-TIME OPTIMIZATION CONFIG ===
const FRAME_BATCH_INTERVAL_MS = 33 // ~30 batches/sec for smooth real-time (was sending every frame)
const FRAME_THROTTLE_MS = 16 // Max ~60fps per headset (prevent flooding)
const MAX_FRAME_BATCH_SIZE = 5 // Max frames per batch to prevent memory growth

// === MEMORY MANAGEMENT CONFIG ===
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // Clean up sessions hourly
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000 // Completed sessions expire after 24h
const OFFLINE_DEVICE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // Offline devices expire after 7 days
const TELEMETRY_HISTORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // Clean up telemetry hourly

const port = 3200
const app = express()

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

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
        // Add your production domains here
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

const s3Region = process.env.AWS_REGION || 'eu-west-1'
const s3Bucket = process.env.S3_BUCKET_NAME || 'turing-robotics-datahub'

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

type UploadSessionBody = {
    sessionId?: string
    timestamp?: string
}

type MulterS3File = Express.Multer.File & {
    bucket: string
    key: string
    location: string
    etag: string
}

type MulterFiles = {
    video?: MulterS3File[]
    data?: MulterS3File[]
}

// Chunked upload types
interface StartChunkedUploadRequest {
    timestamp: string
    fileType: 'video' | 'data'
    fileSize: number
    fileName?: string
}

interface CompleteChunkedUploadRequest {
    uploadId: string
    s3Key: string
    parts: { partNumber: number; etag: string }[]
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

            const sessionId = bodySessionId || Date.now().toString()

            const files = (req.files || {}) as MulterFiles
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
            trackUploadError(err?.code || 'unknown')

            if (err?.code === 'LIMIT_FILE_SIZE') {
                res.status(413).json({ ok: false, error: 'file_too_large' })
                return
            }

            if (String(err?.message || '').includes('timestamp field is required')) {
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
    const devices = Array.from((global as any).deviceStates?.values() || []).map((state: any) => ({
        deviceId: state.deviceId,
        isOnline: state.isOnline,
        lastSeen: state.lastSeen?.toISOString?.() || state.lastSeen,
        connectionTime: state.connectionTime?.toISOString?.() || state.connectionTime,
        telemetry: state.telemetry,
        // NEW: Lock status
        isLocked: !!state.lockedByTabletId,
        lockedByTabletId: state.lockedByTabletId
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
    const state = (global as any).deviceStates?.get(deviceId)

    if (!state) {
        res.status(404).json({ ok: false, error: 'Device not found' })
        return
    }

    res.json({
        ok: true,
        device: {
            deviceId: state.deviceId,
            isOnline: state.isOnline,
            lastSeen: state.lastSeen?.toISOString?.() || state.lastSeen,
            connectionTime: state.connectionTime?.toISOString?.() || state.connectionTime,
            telemetry: state.telemetry,
            isLocked: !!state.lockedByTabletId,
            lockedByTabletId: state.lockedByTabletId
        }
    })
})

// Get device telemetry history (for charts)
app.get('/api/devices/:deviceId/history', (req: Request, res: Response) => {
    const { deviceId } = req.params
    const history = (global as any).telemetryHistory?.get(deviceId) || []

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
    const { customName } = req.body

    // Get or create device info in database
    let deviceInfo = (global as any).deviceDB?.get(deviceId)
    if (!deviceInfo) {
        deviceInfo = {
            deviceId,
            customName: customName || '',
            firstSeen: new Date().toISOString()
        }
    } else {
        deviceInfo.customName = customName || ''
    }

    // Save to in-memory database
    if (!(global as any).deviceDB) {
        (global as any).deviceDB = new Map()
    }
    (global as any).deviceDB.set(deviceId, deviceInfo)

    // Update device state if online
    const state = (global as any).deviceStates?.get(deviceId)
    if (state && state.telemetry) {
        state.telemetry.customName = customName
    }

    fleetLogger.info({ deviceId, customName }, 'Device renamed')
    res.json({ ok: true, customName })
})

// Get fleet summary statistics - NOW WITH LOCKED COUNT
app.get('/api/fleet/summary', (req: Request, res: Response) => {
    const states = Array.from((global as any).deviceStates?.values() || []) as any[]

    const summary = {
        totalDevices: states.length,
        onlineDevices: states.filter(s => s.isOnline).length,
        offlineDevices: states.filter(s => !s.isOnline).length,
        recordingDevices: states.filter(s => s.telemetry?.isRecording).length,
        lowBatteryDevices: states.filter(s => s.telemetry?.batteryLevel < 0.25 && s.isOnline).length,
        lockedDevices: states.filter(s => s.lockedByTabletId).length, // NEW
        avgBatteryLevel: states.length > 0
            ? states.reduce((sum, s) => sum + (s.telemetry?.batteryLevel || 0), 0) / states.length
            : 0,
        totalProductiveTime: states.reduce((sum, s) => sum + (s.telemetry?.productiveTime || 0), 0),
        appVersions: [...new Set(states.map(s => s.telemetry?.appVersion).filter(Boolean))]
    }

    res.json({ ok: true, summary })
})

// =============================================================================
// SESSION REST API
// =============================================================================

// Get all sessions
app.get('/api/sessions', (req: Request, res: Response) => {
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
    pingInterval: 10000,
    pingTimeout: 20000,
    connectTimeout: 45000,

    // === BUFFER OPTIMIZATION ===
    maxHttpBufferSize: 1e8,

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

// =============================================================================
// SESSION MANAGEMENT FOR MULTI-QUEST CAPTURES
// =============================================================================

interface CaptureSession {
    sessionId: string
    tabletId: string
    deviceIds: string[]
    status: 'pending' | 'recording' | 'paused' | 'completed' | 'uploading'
    createdAt: Date
    startedAt?: Date
    endedAt?: Date
    metadata?: Record<string, unknown>
    deviceStatuses: Map<string, {
        isRecording: boolean
        frameCount: number
        uploadProgress: number
        uploadStatus: 'pending' | 'uploading' | 'completed' | 'failed'
    }>
}

const captureSessions: Map<string, CaptureSession> = new Map()
const tabletSessions: Map<string, string> = new Map() // tabletSocketId -> sessionId

// === FRAME BATCHING FOR REAL-TIME ===
const frameBatches: Record<string, string[]> = {}
const lastFrameTime: Record<string, number> = {}

// === HEADSET LIST CHANGE DETECTION ===
let lastHeadsetListJson = ''

// =============================================================================
// FLEET DASHBOARD - DEVICE TELEMETRY STATE
// =============================================================================

interface DeviceTelemetry {
    deviceId: string
    deviceName: string
    customName?: string
    timestamp: number
    batteryLevel: number
    batteryState: number
    storageUsedBytes: number
    storageTotalBytes: number
    wifiSignalLevel: number
    wifiSSID: string
    appVersion: string
    osVersion: string
    sdkVersion: string
    leftHandTracked: boolean
    rightHandTracked: boolean
    bodyTracked: boolean
    trackingConfidence: number
    isRecording: boolean
    sessionDuration: number
    productiveTime: number
    frameCount: number
    droppedFrames: number
    cpuTemperature: number
    gpuTemperature: number
    memoryUsedMB: number
    memoryTotalMB: number
}

interface DeviceState {
    deviceId: string
    socketId: string
    isOnline: boolean
    lastSeen: Date
    telemetry: DeviceTelemetry | null
    connectionTime: Date
    // NEW: Device locking
    lockedByTabletId?: string
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

function broadcastHeadsetList() {
    const onlineDevices = Array.from(deviceStates.values())
        .filter(state => state.isOnline)
        .map(state => ({
            deviceId: state.deviceId,
            isLocked: !!state.lockedByTabletId,
            lockedByTabletId: state.lockedByTabletId,
            customName: state.telemetry?.customName || ''
        }))

    // For NEW clients - send full HeadsetInfo objects with lock status
    const jsonNew = JSON.stringify(onlineDevices)
    if (jsonNew !== lastHeadsetListJson) {
        lastHeadsetListJson = jsonNew
        io.emit('on-headsets-with-lock-status-updated', onlineDevices)
        
        // For OLD clients - send just device IDs as simple string array
        const deviceIds = onlineDevices.map(d => d.deviceId)
        io.emit('on-headsets-updated', deviceIds)
    }
}

function broadcastDeviceLockStatus() {
    const lockStatus = Array.from(deviceStates.values())
        .filter(state => state.isOnline)
        .map(state => ({
            deviceId: state.deviceId,
            isLocked: !!state.lockedByTabletId,
            lockedByTabletId: state.lockedByTabletId
        }))

    io.emit('on-device-locks-updated', lockStatus)
}

// =============================================================================
// SOCKET.IO EVENT HANDLERS
// =============================================================================

io.on('connection', (socket: Socket) => {
    socketLogger.info({ socketId: socket.id }, 'Client connected')

    // === HEADSET EVENTS ===

    socket.on('headset-identify', (deviceId: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'headset-identify')) return

        // Validate input
        if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 100) {
            socketLogger.warn({ socketId: socket.id }, 'Invalid deviceId received')
            return
        }

        connectedHeadsets[socket.id] = deviceId
        socket.join(deviceId)
        socket.join('headsets') // Join headsets room for targeted broadcasts

        // Update or create device state
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
        } else {
            state.socketId = socket.id
            state.isOnline = true
            state.lastSeen = new Date()
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
        if (!headsetId) return

        // Validate data size (prevent memory exhaustion)
        if (typeof data !== 'string' || data.length > 1024 * 1024) return // Max 1MB per frame

        const now = Date.now()
        const lastTime = lastFrameTime[socket.id] || 0

        if (now - lastTime < FRAME_THROTTLE_MS) return
        lastFrameTime[socket.id] = now

        if (!frameBatches[headsetId]) frameBatches[headsetId] = []

        // Enforce frame batch size limit to prevent memory growth
        if (frameBatches[headsetId].length >= MAX_FRAME_BATCH_SIZE) {
            frameBatches[headsetId].shift() // Drop oldest frame
        }
        frameBatches[headsetId].push(data)
    })

    // Status updates (1fps)
    socket.on('headset-status', (data: string) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'headset-status')) return

        const headsetId = connectedHeadsets[socket.id]
        if (!headsetId) return

        // Validate data size
        if (typeof data !== 'string' || data.length > 10000) return

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
            const deviceId = telemetry.deviceId || connectedHeadsets[socket.id]

            if (!deviceId) return

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
            const lastSample = lastHistorySample.get(deviceId) || 0
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
        const headsetId = connectedHeadsets[socket.id]
        if (!headsetId) return

        const idx = recordingHeadsets.indexOf(headsetId)
        if (idx !== -1) recordingHeadsets.splice(idx, 1)

        if (recording) recordingHeadsets.push(headsetId)

        // Legacy events (backwards compatibility)
        io.to(headsetId).emit(
            recording ? 'on-headset-recording-active' : 'on-headset-recording-inactive'
        )

        // NEW: Multi-device aware event with deviceId included
        io.to(headsetId).emit('on-device-recording-changed', {
            deviceId: headsetId,
            isRecording: recording
        })
        deviceLogger.info({ deviceId: headsetId, isRecording: recording }, 'Device recording state changed')
        trackSocketEvent('headset-recording-state')
    })

    // =========================================================================
    // MULTI-DEVICE TABLET EVENTS (NEW)
    // =========================================================================

    // Lock a device (exclusive control - prevents other tablets from using it)
    socket.on('tablet-lock-device', (deviceId: string) => {
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

    // Lock multiple devices at once with validation and rate limiting
    socket.on('tablet-lock-devices', (deviceIds: string[]) => {
        // Rate limit check
        if (checkSocketRateLimit(socket.id, 'tablet-lock-devices')) return

        // Validate input
        if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > 50) {
            socket.emit('on-devices-locked', { locked: [], failed: [], error: 'Invalid device list' })
            return
        }

        // Validate each device ID
        for (const id of deviceIds) {
            if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
                socket.emit('on-devices-locked', { locked: [], failed: deviceIds, error: 'Invalid device ID format' })
                return
            }
        }

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

        // Now lock all validated devices atomically
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
    })

    // Unlock all devices
    socket.on('tablet-unlock-all-devices', () => {
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

    // Start recording for a specific device
    socket.on('tablet-start-recording', (deviceId: string) => {
        const state = deviceStates.get(deviceId)
        if (state?.lockedByTabletId && state.lockedByTabletId !== socket.id) {
            socket.emit('on-recording-denied', { deviceId })
            return
        }

        // Only start if not already recording
        const isRecording = recordingHeadsets.includes(deviceId)
        if (!isRecording) {
            io.to(deviceId).emit('on-tablet-start-recording')
            deviceLogger.info({ deviceId, tabletId: socket.id }, 'Tablet started recording for device')
            trackSocketEvent('tablet-start-recording')
        }
    })

    // Stop recording for a specific device
    socket.on('tablet-stop-recording', (deviceId: string) => {
        const state = deviceStates.get(deviceId)
        if (state?.lockedByTabletId && state.lockedByTabletId !== socket.id) {
            socket.emit('on-recording-denied', { deviceId })
            return
        }

        // Only stop if currently recording
        const isRecording = recordingHeadsets.includes(deviceId)
        if (isRecording) {
            io.to(deviceId).emit('on-tablet-stop-recording')
            deviceLogger.info({ deviceId, tabletId: socket.id }, 'Tablet stopped recording for device')
            trackSocketEvent('tablet-stop-recording')
        }
    })

    // Start recording for ALL locked devices
    socket.on('tablet-start-all-recording', () => {
        const tabletLocks = tabletDeviceLocks.get(socket.id)
        if (!tabletLocks || tabletLocks.size === 0) {
            deviceLogger.debug({ tabletId: socket.id }, 'Start all: No devices locked')
            return
        }

        let startedCount = 0
        for (const deviceId of tabletLocks) {
            const isRecording = recordingHeadsets.includes(deviceId)
            if (!isRecording) {
                io.to(deviceId).emit('on-tablet-start-recording')
                startedCount++
            }
        }
        deviceLogger.info({ tabletId: socket.id, startedCount, totalDevices: tabletLocks.size }, 'Started recording for all devices')
        trackSocketEvent('tablet-start-all-recording')
    })

    // Stop recording for ALL locked devices
    socket.on('tablet-stop-all-recording', () => {
        const tabletLocks = tabletDeviceLocks.get(socket.id)
        if (!tabletLocks || tabletLocks.size === 0) {
            deviceLogger.debug({ tabletId: socket.id }, 'Stop all: No devices locked')
            return
        }

        let stoppedCount = 0
        for (const deviceId of tabletLocks) {
            const isRecording = recordingHeadsets.includes(deviceId)
            if (isRecording) {
                io.to(deviceId).emit('on-tablet-stop-recording')
                stoppedCount++
            }
        }
        deviceLogger.info({ tabletId: socket.id, stoppedCount, totalDevices: tabletLocks.size }, 'Stopped recording for all devices')
        trackSocketEvent('tablet-stop-all-recording')
    })

    // =========================================================================
    // SESSION MANAGEMENT EVENTS
    // =========================================================================

    // Create a new capture session with selected devices
    socket.on('tablet-create-session', (data: { deviceIds: string[], metadata?: Record<string, unknown> }) => {
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
        const recording = recordingHeadsets.indexOf(headsetId) !== -1
        socket.emit(recording ? 'on-recording-active' : 'on-recording-inactive')
    })

    socket.on('tablet-sync-metadata', (data: string, targetDeviceId?: string) => {
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

        // Release all device locks held by this tablet
        const tabletLocks = tabletDeviceLocks.get(socket.id)
        if (tabletLocks && tabletLocks.size > 0) {
            for (const deviceId of tabletLocks) {
                const state = deviceStates.get(deviceId)
                if (state && state.lockedByTabletId === socket.id) {
                    state.lockedByTabletId = undefined
                    state.lockedAt = undefined
                    deviceLogger.info({ deviceId, tabletId: socket.id }, 'Released lock on device')
                    trackDeviceUnlock()
                }
            }
            tabletDeviceLocks.delete(socket.id)
            broadcastDeviceLockStatus()
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
            delete lastFrameTime[socket.id]
            delete frameBatches[headsetId]

            // Mark device offline
            const state = deviceStates.get(headsetId)
            if (state) {
                state.isOnline = false
                state.lastSeen = new Date()

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

// Dynamic frame batch emission with adaptive throttling
let lastBatchEmission = Date.now()

function calculateDynamicFrameInterval(): number {
    // Adapt frame rate based on number of watchers (tablets/dashboards)
    const watcherCount = dashboardSubscribers.size + tabletDeviceLocks.size

    if (watcherCount === 0) return 1000 // 1fps if nobody watching (save resources)
    if (watcherCount === 1) return 33   // 30fps for single watcher
    if (watcherCount <= 3) return 50    // 20fps for few watchers
    if (watcherCount <= 10) return 100  // 10fps for multiple watchers
    return 200                          // 5fps for many watchers (scale gracefully)
}

// Batch frame emission with adaptive throttling
setInterval(() => {
    const now = Date.now()
    const dynamicInterval = calculateDynamicFrameInterval()

    // Skip emission if not enough time has passed (adaptive throttle)
    if (now - lastBatchEmission < dynamicInterval) return
    lastBatchEmission = now

    for (const headsetId in frameBatches) {
        const batch = frameBatches[headsetId]
        if (batch.length === 0) continue

        // Only emit if there are actual watchers in the room
        const room = io.sockets.adapter.rooms.get(headsetId)
        const watcherCount = room ? room.size : 0

        // Skip if only the headset itself is in the room (no tablet watching)
        if (watcherCount <= 1) {
            frameBatches[headsetId] = [] // Clear batch to prevent memory buildup
            continue
        }

        // Send only the latest frame to reduce bandwidth
        const latestFrame = batch[batch.length - 1]
        io.to(headsetId).emit('on-headset-frame-updated', latestFrame)
        frameBatches[headsetId] = []
    }
}, 16) // Check frequently (60Hz), but emit at dynamic rate

// Broadcast headset list periodically
setInterval(() => {
    broadcastHeadsetList()
}, CONNECTED_HEADSETS_BROADCAST_FREQUENCY)

// =============================================================================
// MEMORY CLEANUP TASKS
// =============================================================================

// Clean up expired sessions (completed sessions older than 24h)
setInterval(() => {
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
}, SESSION_CLEANUP_INTERVAL_MS)

// Clean up offline devices not seen for extended period
setInterval(() => {
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
}, SESSION_CLEANUP_INTERVAL_MS)

// Clean up orphaned telemetry history (devices no longer in deviceStates)
setInterval(() => {
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
}, TELEMETRY_HISTORY_CLEANUP_INTERVAL_MS)

// =============================================================================
// START SERVER
// =============================================================================

server.listen(port, () => {
    serverLogger.info({
        port,
        s3Bucket,
        environment: isDevelopment ? 'development' : 'production',
        features: [
            'Multi-device tablet control',
            'Device locking (prevents conflicts)',
            'Real-time optimization',
            'Chunked uploads (20GB max)',
            'Rate limiting & validation',
            'JWT authentication',
            'Prometheus metrics (/metrics)',
            'Structured logging (pino)'
        ]
    }, 'Turing Backend v2.3 started - Secure Multi-Device with Observability')
})

// Import S3 Stats Router
import { createS3StatsRouter } from "./s3-stats"

// Mount S3 Stats endpoints (PROTECTED with API Key)
app.use("/api", adminAuthMiddleware, createS3StatsRouter())

console.log("[S3Stats] S3 statistics API mounted at /api/s3-stats (PROTECTED)")

// QA Metrics API (PROTECTED with API Key)
import { createQAMetricsRouter } from './qa-metrics';
app.use('/api', adminAuthMiddleware, createQAMetricsRouter());
console.log('[QAMetrics] QA metrics API mounted at /api/qa-metrics (PROTECTED)');
