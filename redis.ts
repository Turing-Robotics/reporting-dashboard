/**
 * Redis State Management module for Turing VR Backend
 *
 * Provides Redis-backed state management for:
 * - Device states (online status, lock status)
 * - Device locks (atomic lock acquisition using SET NX)
 * - Session management
 * - Telemetry caching
 *
 * Falls back gracefully to in-memory state if Redis is unavailable.
 *
 * @module redis
 */

import { createClient, RedisClientType } from 'redis'
import { redisLogger } from './logger'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Represents the state of a device stored in Redis.
 * All timestamps are stored as ISO 8601 strings for portability.
 */
export interface RedisDeviceState {
    /** Unique device identifier */
    deviceId: string
    /** Current Socket.IO socket ID for this device */
    socketId: string
    /** Whether the device is currently connected */
    isOnline: boolean
    /** ISO timestamp of last activity */
    lastSeen: string
    /** ISO timestamp when device first connected in current session */
    connectionTime: string
    /** Socket ID of tablet that has locked this device (if any) */
    lockedByTabletId?: string
    /** ISO timestamp when the device was locked (if locked) */
    lockedAt?: string
}

/**
 * Represents a capture session stored in Redis.
 * Sessions track multi-device recording coordination.
 */
export interface RedisSessionState {
    /** Unique session identifier */
    sessionId: string
    /** Socket ID of the tablet that created this session */
    tabletId: string
    /** Array of device IDs participating in this session */
    deviceIds: string[]
    /** Current status of the session */
    status: 'pending' | 'recording' | 'paused' | 'completed' | 'uploading'
    /** ISO timestamp when session was created */
    createdAt: string
    /** ISO timestamp when recording started (if started) */
    startedAt?: string
    /** ISO timestamp when session ended (if ended) */
    endedAt?: string
    /** JSON-encoded metadata for the session (if any) */
    metadata?: string
}

// =============================================================================
// REDIS CLIENT
// =============================================================================

/** The Redis client instance (null if not connected) */
let redis: RedisClientType | null = null

/** Whether the Redis connection is currently active */
let isConnected: boolean = false

/** Number of connection/reconnection attempts made */
let connectionAttempts: number = 0

/** Maximum number of reconnection attempts before giving up */
const MAX_CONNECTION_ATTEMPTS: number = parseInt(process.env.REDIS_MAX_RETRIES || '10', 10)

/** Delay between reconnection attempts in milliseconds */
const REDIS_RETRY_DELAY_MS: number = parseInt(process.env.REDIS_RETRY_DELAY_MS || '3000', 10)

/**
 * Initializes the Redis connection with automatic reconnection handling.
 *
 * If Redis is unavailable, the server will continue to function using
 * in-memory state only. This allows the application to work in
 * environments without Redis while still benefiting from Redis
 * when available.
 *
 * @returns `true` if Redis connected successfully, `false` otherwise
 *
 * @example
 * ```typescript
 * const redisAvailable = await initRedis()
 * if (redisAvailable) {
 *   console.log('Using Redis for state persistence')
 * } else {
 *   console.log('Using in-memory state only')
 * }
 * ```
 */
export async function initRedis(): Promise<boolean> {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'

    try {
        redis = createClient({
            url: redisUrl,
            socket: {
                reconnectStrategy: (retries) => {
                    connectionAttempts = retries
                    if (retries > MAX_CONNECTION_ATTEMPTS) {
                        redisLogger.error({ retries, maxRetries: MAX_CONNECTION_ATTEMPTS }, 'Max reconnection attempts reached, falling back to in-memory state')
                        isConnected = false
                        return false // Stop reconnecting
                    }
                    const delay = Math.min(retries * 100, REDIS_RETRY_DELAY_MS)
                    redisLogger.info({ retries, delayMs: delay }, 'Scheduling Redis reconnection')
                    return delay
                },
                connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '10000', 10)
            }
        })

        redis.on('error', (err) => {
            redisLogger.error({ err: err.message }, 'Redis connection error')
            isConnected = false
        })

        redis.on('connect', () => {
            redisLogger.info('Redis connected successfully')
            isConnected = true
            connectionAttempts = 0
        })

        redis.on('reconnecting', () => {
            redisLogger.info({ attempt: connectionAttempts }, 'Redis reconnecting...')
        })

        redis.on('end', () => {
            redisLogger.warn('Redis connection closed')
            isConnected = false
        })

        await redis.connect()
        isConnected = true
        redisLogger.info({ redisUrl: redisUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') }, 'Redis initialized')
        return true
    } catch (err: any) {
        redisLogger.warn({ err: err.message }, 'Failed to connect to Redis, using in-memory state')
        isConnected = false
        redis = null
        return false
    }
}

/**
 * Checks if Redis is currently available and connected.
 *
 * Use this to conditionally perform Redis operations or fall back
 * to in-memory alternatives.
 *
 * @returns `true` if Redis is connected and ready, `false` otherwise
 *
 * @example
 * ```typescript
 * if (isRedisAvailable()) {
 *   await redisSetDeviceState(deviceId, state)
 * } else {
 *   // Use in-memory state
 * }
 * ```
 */
export function isRedisAvailable(): boolean {
    return isConnected && redis !== null
}

/**
 * Gets the Redis client for direct operations.
 *
 * Use this when you need to perform Redis operations not covered
 * by the helper functions in this module.
 *
 * @returns The Redis client instance, or `null` if not connected
 *
 * @example
 * ```typescript
 * const client = getRedisClient()
 * if (client) {
 *   const value = await client.get('my-key')
 * }
 * ```
 */
export function getRedisClient(): RedisClientType | null {
    return redis
}

// =============================================================================
// DEVICE STATE OPERATIONS
// =============================================================================

/** Redis key prefix for device state hashes */
const DEVICE_STATE_PREFIX: string = 'device:'

/** TTL for device state entries in seconds (24 hours) */
const DEVICE_STATE_TTL: number = 3600 * 24

/**
 * Saves or updates device state in Redis.
 *
 * Uses a Redis hash to store device fields, allowing partial updates.
 * Each device state entry has a 24-hour TTL to automatically clean up
 * stale entries.
 *
 * @param deviceId - The unique device identifier
 * @param state - Partial device state to save (only provided fields are updated)
 * @returns `true` if the operation succeeded, `false` if Redis unavailable or error
 *
 * @example
 * ```typescript
 * await setDeviceState('QUEST_001', {
 *   isOnline: true,
 *   lastSeen: new Date().toISOString()
 * })
 * ```
 */
export async function setDeviceState(deviceId: string, state: Partial<RedisDeviceState>): Promise<boolean> {
    if (!isRedisAvailable()) return false

    try {
        const key = `${DEVICE_STATE_PREFIX}${deviceId}`
        const fields: Record<string, string> = {}

        if (state.socketId !== undefined) fields.socketId = state.socketId
        if (state.isOnline !== undefined) fields.isOnline = state.isOnline ? '1' : '0'
        if (state.lastSeen !== undefined) fields.lastSeen = state.lastSeen
        if (state.connectionTime !== undefined) fields.connectionTime = state.connectionTime
        if (state.lockedByTabletId !== undefined) fields.lockedByTabletId = state.lockedByTabletId ?? ''
        if (state.lockedAt !== undefined) fields.lockedAt = state.lockedAt ?? ''

        await redis!.hSet(key, fields)
        await redis!.expire(key, DEVICE_STATE_TTL)
        return true
    } catch (err: any) {
        redisLogger.error({ deviceId, err: err.message }, 'Failed to set device state')
        return false
    }
}

/**
 * Retrieves device state from Redis.
 *
 * @param deviceId - The unique device identifier
 * @returns The device state if found, `null` if not found or Redis unavailable
 *
 * @example
 * ```typescript
 * const state = await getDeviceState('QUEST_001')
 * if (state) {
 *   console.log(`Device ${state.deviceId} is ${state.isOnline ? 'online' : 'offline'}`)
 * }
 * ```
 */
export async function getDeviceState(deviceId: string): Promise<RedisDeviceState | null> {
    if (!isRedisAvailable()) return null

    try {
        const key = `${DEVICE_STATE_PREFIX}${deviceId}`
        const data = await redis!.hGetAll(key)

        if (!data.socketId) return null

        return {
            deviceId,
            socketId: data.socketId,
            isOnline: data.isOnline === '1',
            lastSeen: data.lastSeen,
            connectionTime: data.connectionTime,
            lockedByTabletId: data.lockedByTabletId ? data.lockedByTabletId : undefined,
            lockedAt: data.lockedAt ? data.lockedAt : undefined
        }
    } catch (err: any) {
        redisLogger.error({ deviceId, err: err.message }, 'Failed to get device state')
        return null
    }
}

/**
 * Iterates over all online devices using SCAN (non-blocking).
 *
 * Uses Redis SCAN command instead of KEYS to avoid blocking the Redis server.
 * SCAN is O(1) per call and iterates incrementally through the keyspace,
 * making it safe for production use with large datasets.
 *
 * @yields Device state objects for online devices
 *
 * @example
 * ```typescript
 * for await (const device of scanOnlineDevices()) {
 *   console.log(`Device ${device.deviceId} is online`)
 * }
 * ```
 */
export async function* scanOnlineDevices(): AsyncGenerator<RedisDeviceState> {
    if (!redis || !isConnected) return

    try {
        for await (const key of redis.scanIterator({
            MATCH: `${DEVICE_STATE_PREFIX}*`,
            COUNT: 100  // Process 100 keys per SCAN iteration
        })) {
            const deviceId = key.replace(DEVICE_STATE_PREFIX, '')
            const state = await getDeviceState(deviceId)
            if (state?.isOnline) {
                yield state
            }
        }
    } catch (err: any) {
        redisLogger.error({ err: err.message }, 'Error scanning online devices')
    }
}

/**
 * Gets all online devices (convenience wrapper for non-generator contexts).
 *
 * Uses SCAN internally for better performance. This function collects all
 * results into an array, so for very large datasets consider using
 * `scanOnlineDevices()` directly to process devices incrementally.
 *
 * @returns Array of online device states, empty array if Redis unavailable
 *
 * @example
 * ```typescript
 * const onlineDevices = await getAllOnlineDevices()
 * console.log(`${onlineDevices.length} devices currently online`)
 * ```
 */
export async function getAllOnlineDevices(): Promise<RedisDeviceState[]> {
    const devices: RedisDeviceState[] = []
    for await (const device of scanOnlineDevices()) {
        devices.push(device)
    }
    return devices
}

/**
 * Gets the count of online devices without fetching all data.
 *
 * More efficient than `getAllOnlineDevices().length` when you only need
 * the count and don't need the actual device data.
 *
 * Uses Redis SCAN command to iterate through device keys non-blocking.
 *
 * @returns The number of online devices, 0 if Redis unavailable
 *
 * @example
 * ```typescript
 * const count = await getOnlineDeviceCount()
 * console.log(`${count} devices currently online`)
 * ```
 */
export async function getOnlineDeviceCount(): Promise<number> {
    if (!redis || !isConnected) return 0

    try {
        let count = 0
        for await (const key of redis.scanIterator({
            MATCH: `${DEVICE_STATE_PREFIX}*`,
            COUNT: 100
        })) {
            const deviceId = key.replace(DEVICE_STATE_PREFIX, '')
            const state = await getDeviceState(deviceId)
            if (state?.isOnline) {
                count++
            }
        }
        return count
    } catch (err: any) {
        redisLogger.error({ err: err.message }, 'Failed to count online devices')
        return 0
    }
}

/**
 * Marks a device as offline in Redis.
 *
 * Updates the device's online status and last seen timestamp.
 * The device state is preserved (not deleted) to maintain history.
 *
 * @param deviceId - The unique device identifier
 * @returns `true` if the operation succeeded, `false` if Redis unavailable or error
 *
 * @example
 * ```typescript
 * socket.on('disconnect', async () => {
 *   await markDeviceOffline(deviceId)
 * })
 * ```
 */
export async function markDeviceOffline(deviceId: string): Promise<boolean> {
    return setDeviceState(deviceId, {
        isOnline: false,
        lastSeen: new Date().toISOString()
    })
}

// =============================================================================
// DEVICE LOCKING OPERATIONS (ATOMIC)
// =============================================================================

/** Redis key prefix for device locks */
const LOCK_PREFIX: string = 'lock:'

/** TTL for device locks in seconds (2 hours) */
const LOCK_TTL: number = 7200

/** Redis key prefix for tablet lock sets */
const TABLET_LOCKS_PREFIX: string = 'tablet_locks:'

/**
 * Attempts to acquire an exclusive lock on a device for a tablet.
 *
 * Uses Redis SET NX (set if not exists) for atomic lock acquisition.
 * This prevents race conditions when multiple tablets try to lock
 * the same device simultaneously.
 *
 * Lock behavior:
 * - If device is unlocked: Lock is acquired
 * - If device is locked by same tablet: Returns true (idempotent)
 * - If device is locked by different tablet: Returns false
 * - Locks automatically expire after 2 hours (LOCK_TTL)
 *
 * @param deviceId - The unique device identifier to lock
 * @param tabletId - The Socket.IO socket ID of the tablet requesting the lock
 * @returns `true` if lock was acquired (or already held), `false` if locked by another tablet
 *
 * @example
 * ```typescript
 * const acquired = await lockDevice('QUEST_001', socket.id)
 * if (acquired) {
 *   console.log('Device locked successfully')
 * } else {
 *   console.log('Device is locked by another tablet')
 * }
 * ```
 */
export async function lockDevice(deviceId: string, tabletId: string): Promise<boolean> {
    if (!isRedisAvailable()) return false

    try {
        const lockKey = `${LOCK_PREFIX}${deviceId}`

        // Try to acquire lock atomically (SET NX = only if not exists)
        const acquired = await redis!.set(lockKey, tabletId, {
            NX: true, // Only set if not exists
            EX: LOCK_TTL // Expire after TTL
        })

        if (acquired) {
            // Add to tablet's lock set
            await redis!.sAdd(`${TABLET_LOCKS_PREFIX}${tabletId}`, deviceId)

            // Update device state
            await setDeviceState(deviceId, {
                lockedByTabletId: tabletId,
                lockedAt: new Date().toISOString()
            })

            redisLogger.info({ deviceId, tabletId }, 'Device locked')
            return true
        }

        // Check if already locked by same tablet (idempotent)
        const currentLock = await redis!.get(lockKey)
        if (currentLock === tabletId) {
            redisLogger.debug({ deviceId, tabletId }, 'Device already locked by same tablet')
            return true
        }

        redisLogger.debug({ deviceId, tabletId, lockedBy: currentLock }, 'Device lock failed - already locked')
        return false
    } catch (err: any) {
        redisLogger.error({ deviceId, tabletId, err: err.message }, 'Failed to lock device')
        return false
    }
}

/**
 * Releases a lock on a device.
 *
 * Only the tablet that holds the lock can unlock the device.
 * Attempting to unlock a device locked by another tablet will fail.
 *
 * @param deviceId - The unique device identifier to unlock
 * @param tabletId - The Socket.IO socket ID of the tablet releasing the lock
 * @returns `true` if the device was unlocked, `false` if tablet doesn't hold the lock
 *
 * @example
 * ```typescript
 * const unlocked = await unlockDevice('QUEST_001', socket.id)
 * if (unlocked) {
 *   console.log('Device unlocked successfully')
 * } else {
 *   console.log('Cannot unlock - device is locked by another tablet')
 * }
 * ```
 */
export async function unlockDevice(deviceId: string, tabletId: string): Promise<boolean> {
    if (!isRedisAvailable()) return false

    try {
        const lockKey = `${LOCK_PREFIX}${deviceId}`

        // Verify this tablet owns the lock
        const currentLock = await redis!.get(lockKey)
        if (currentLock && currentLock !== tabletId) {
            redisLogger.warn({ deviceId, tabletId, lockedBy: currentLock }, 'Tablet tried to unlock device owned by another')
            return false
        }

        // Remove lock
        await redis!.del(lockKey)

        // Remove from tablet's lock set
        await redis!.sRem(`${TABLET_LOCKS_PREFIX}${tabletId}`, deviceId)

        // Update device state
        await setDeviceState(deviceId, {
            lockedByTabletId: '',
            lockedAt: ''
        })

        redisLogger.info({ deviceId, tabletId }, 'Device unlocked')
        return true
    } catch (err: any) {
        redisLogger.error({ deviceId, tabletId, err: err.message }, 'Failed to unlock device')
        return false
    }
}

/**
 * Gets all device IDs currently locked by a specific tablet.
 *
 * @param tabletId - The Socket.IO socket ID of the tablet
 * @returns Array of device IDs locked by this tablet, empty array if none or Redis unavailable
 *
 * @example
 * ```typescript
 * const lockedDevices = await getTabletLocks(socket.id)
 * console.log(`Tablet has ${lockedDevices.length} devices locked`)
 * ```
 */
export async function getTabletLocks(tabletId: string): Promise<string[]> {
    if (!isRedisAvailable()) return []

    try {
        const members = await redis!.sMembers(`${TABLET_LOCKS_PREFIX}${tabletId}`)
        return members
    } catch (err: any) {
        redisLogger.error({ tabletId, err: err.message }, 'Failed to get tablet locks')
        return []
    }
}

/**
 * Releases all device locks held by a tablet.
 *
 * Typically called when a tablet disconnects to ensure devices
 * are not left in a locked state indefinitely.
 *
 * @param tabletId - The Socket.IO socket ID of the disconnecting tablet
 * @returns Array of device IDs that were unlocked, empty array if none or Redis unavailable
 *
 * @example
 * ```typescript
 * socket.on('disconnect', async () => {
 *   const unlockedDevices = await unlockAllForTablet(socket.id)
 *   console.log(`Released locks on ${unlockedDevices.length} devices`)
 * })
 * ```
 */
export async function unlockAllForTablet(tabletId: string): Promise<string[]> {
    if (!isRedisAvailable()) return []

    try {
        const deviceIds = await getTabletLocks(tabletId)

        for (const deviceId of deviceIds) {
            await unlockDevice(deviceId, tabletId)
        }

        // Clear tablet's lock set
        await redis!.del(`${TABLET_LOCKS_PREFIX}${tabletId}`)

        redisLogger.info({ tabletId, releasedCount: deviceIds.length }, 'Released all locks for tablet')
        return deviceIds
    } catch (err: any) {
        redisLogger.error({ tabletId, err: err.message }, 'Failed to unlock all devices for tablet')
        return []
    }
}

/**
 * Gets the tablet ID that holds the lock on a device.
 *
 * @param deviceId - The unique device identifier
 * @returns The tablet's socket ID if device is locked, `null` if unlocked or Redis unavailable
 *
 * @example
 * ```typescript
 * const lockHolder = await getLockHolder('QUEST_001')
 * if (lockHolder) {
 *   console.log(`Device is locked by tablet ${lockHolder}`)
 * } else {
 *   console.log('Device is available')
 * }
 * ```
 */
export async function getLockHolder(deviceId: string): Promise<string | null> {
    if (!isRedisAvailable()) return null

    try {
        const lockKey = `${LOCK_PREFIX}${deviceId}`
        return await redis!.get(lockKey)
    } catch (err: any) {
        redisLogger.error({ deviceId, err: err.message }, 'Failed to get lock holder')
        return null
    }
}

// =============================================================================
// SESSION OPERATIONS
// =============================================================================

/** Redis key prefix for session hashes */
const SESSION_PREFIX: string = 'session:'

/** TTL for session entries in seconds (7 days) */
const SESSION_TTL: number = 3600 * 24 * 7

/**
 * Creates a new capture session in Redis.
 *
 * Sessions coordinate multi-device recording and track the state
 * of capture across multiple headsets.
 *
 * @param session - The session state to store
 * @returns `true` if session was created, `false` if Redis unavailable or error
 *
 * @example
 * ```typescript
 * await createSession({
 *   sessionId: 'session_123',
 *   tabletId: socket.id,
 *   deviceIds: ['QUEST_001', 'QUEST_002'],
 *   status: 'pending',
 *   createdAt: new Date().toISOString()
 * })
 * ```
 */
export async function createSession(session: RedisSessionState): Promise<boolean> {
    if (!isRedisAvailable()) return false

    try {
        const key = `${SESSION_PREFIX}${session.sessionId}`

        await redis!.hSet(key, {
            sessionId: session.sessionId,
            tabletId: session.tabletId,
            deviceIds: JSON.stringify(session.deviceIds),
            status: session.status,
            createdAt: session.createdAt,
            metadata: session.metadata ?? ''
        })
        await redis!.expire(key, SESSION_TTL)

        redisLogger.info({ sessionId: session.sessionId, tabletId: session.tabletId }, 'Session created')
        return true
    } catch (err: any) {
        redisLogger.error({ sessionId: session.sessionId, err: err.message }, 'Failed to create session')
        return false
    }
}

/**
 * Updates the status of an existing session.
 *
 * Can also update additional fields like startedAt or endedAt timestamps.
 *
 * @param sessionId - The unique session identifier
 * @param status - The new status to set
 * @param additionalFields - Optional additional fields to update (startedAt, endedAt)
 * @returns `true` if update succeeded, `false` if Redis unavailable or error
 *
 * @example
 * ```typescript
 * // Start recording
 * await updateSessionStatus('session_123', 'recording', {
 *   startedAt: new Date().toISOString()
 * })
 *
 * // End session
 * await updateSessionStatus('session_123', 'completed', {
 *   endedAt: new Date().toISOString()
 * })
 * ```
 */
export async function updateSessionStatus(
    sessionId: string,
    status: RedisSessionState['status'],
    additionalFields?: Partial<RedisSessionState>
): Promise<boolean> {
    if (!isRedisAvailable()) return false

    try {
        const key = `${SESSION_PREFIX}${sessionId}`
        const fields: Record<string, string> = { status }

        if (additionalFields?.startedAt) fields.startedAt = additionalFields.startedAt
        if (additionalFields?.endedAt) fields.endedAt = additionalFields.endedAt

        await redis!.hSet(key, fields)
        redisLogger.info({ sessionId, status }, 'Session status updated')
        return true
    } catch (err: any) {
        redisLogger.error({ sessionId, err: err.message }, 'Failed to update session')
        return false
    }
}

/**
 * Retrieves a session by its ID from Redis.
 *
 * @param sessionId - The unique session identifier
 * @returns The session state if found, `null` if not found or Redis unavailable
 *
 * @example
 * ```typescript
 * const session = await getSession('session_123')
 * if (session) {
 *   console.log(`Session status: ${session.status}`)
 *   console.log(`Devices: ${session.deviceIds.join(', ')}`)
 * }
 * ```
 */
export async function getSession(sessionId: string): Promise<RedisSessionState | null> {
    if (!isRedisAvailable()) return null

    try {
        const key = `${SESSION_PREFIX}${sessionId}`
        const data = await redis!.hGetAll(key)

        if (!data.sessionId) return null

        return {
            sessionId: data.sessionId,
            tabletId: data.tabletId,
            deviceIds: JSON.parse(data.deviceIds ?? '[]'),
            status: data.status as RedisSessionState['status'],
            createdAt: data.createdAt,
            startedAt: data.startedAt ? data.startedAt : undefined,
            endedAt: data.endedAt ? data.endedAt : undefined,
            metadata: data.metadata ? data.metadata : undefined
        }
    } catch (err: any) {
        redisLogger.error({ sessionId, err: err.message }, 'Failed to get session')
        return null
    }
}

// =============================================================================
// TELEMETRY CACHING
// =============================================================================

/** Redis key prefix for telemetry cache */
const TELEMETRY_PREFIX: string = 'telemetry:'

/** TTL for telemetry cache entries in seconds (5 minutes) */
const TELEMETRY_TTL: number = 300

/**
 * Caches the latest telemetry data for a device.
 *
 * Telemetry is cached with a short TTL (5 minutes) as it changes
 * frequently and stale data is not useful.
 *
 * @param deviceId - The unique device identifier
 * @param telemetry - The telemetry data to cache (will be JSON serialized)
 * @returns `true` if caching succeeded, `false` if Redis unavailable or error
 *
 * @example
 * ```typescript
 * await cacheTelemetry('QUEST_001', {
 *   batteryLevel: 0.85,
 *   isRecording: true,
 *   wifiSignalLevel: -45
 * })
 * ```
 */
export async function cacheTelemetry(deviceId: string, telemetry: Record<string, unknown>): Promise<boolean> {
    if (!isRedisAvailable()) return false

    try {
        const key = `${TELEMETRY_PREFIX}${deviceId}`
        await redis!.set(key, JSON.stringify(telemetry), { EX: TELEMETRY_TTL })
        return true
    } catch (err: any) {
        redisLogger.error({ deviceId, err: err.message }, 'Failed to cache telemetry')
        return false
    }
}

/**
 * Retrieves cached telemetry data for a device.
 *
 * @param deviceId - The unique device identifier
 * @returns The cached telemetry data if found and not expired, `null` otherwise
 *
 * @example
 * ```typescript
 * const telemetry = await getCachedTelemetry('QUEST_001')
 * if (telemetry) {
 *   console.log(`Battery: ${telemetry.batteryLevel * 100}%`)
 * }
 * ```
 */
export async function getCachedTelemetry(deviceId: string): Promise<Record<string, unknown> | null> {
    if (!isRedisAvailable()) return null

    try {
        const key = `${TELEMETRY_PREFIX}${deviceId}`
        const data = await redis!.get(key)
        return data ? JSON.parse(data) : null
    } catch (err: any) {
        redisLogger.error({ deviceId, err: err.message }, 'Failed to get cached telemetry')
        return null
    }
}

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Gracefully shuts down the Redis connection.
 *
 * Attempts a graceful QUIT first, falling back to forceful disconnect
 * if QUIT fails. Safe to call even if Redis is not connected.
 *
 * @example
 * ```typescript
 * process.on('SIGTERM', async () => {
 *   await shutdownRedis()
 *   process.exit(0)
 * })
 * ```
 */
export async function shutdownRedis(): Promise<void> {
    if (redis) {
        try {
            await redis.quit()
            redisLogger.info('Redis disconnected gracefully')
        } catch (err: any) {
            redisLogger.warn({ err: err.message }, 'Error during Redis shutdown, forcing close')
            await redis.disconnect().catch(() => {})
        } finally {
            redis = null
            isConnected = false
        }
    }
}

export default {
    initRedis,
    isRedisAvailable,
    getRedisClient,
    setDeviceState,
    getDeviceState,
    scanOnlineDevices,
    getAllOnlineDevices,
    getOnlineDeviceCount,
    markDeviceOffline,
    lockDevice,
    unlockDevice,
    getTabletLocks,
    unlockAllForTablet,
    getLockHolder,
    createSession,
    updateSessionStatus,
    getSession,
    cacheTelemetry,
    getCachedTelemetry,
    shutdownRedis
}
