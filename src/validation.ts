/**
 * Input Validation module for Turing VR Backend
 *
 * Provides Joi schemas for validating Socket.IO event payloads
 * and REST API request bodies. Uses Joi for declarative validation
 * with detailed error messages.
 *
 * @module validation
 */

import Joi, { Schema, ValidationResult } from 'joi'
import { socketLogger } from './logger'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of a validation operation.
 * Contains either the validated value or an error message.
 */
interface ValidationOutcome<T> {
    /** The validated and transformed value (if validation succeeded) */
    value?: T
    /** The error message (if validation failed) */
    error?: string
}

/**
 * Payload for the tablet-lock-devices event.
 */
interface LockDevicesPayload {
    /** Array of device IDs to lock */
    deviceIds: string[]
}

/**
 * Payload for the tablet-create-session event.
 */
interface CreateSessionPayload {
    /** Array of device IDs to include in the session */
    deviceIds: string[]
    /** Optional metadata for the session */
    metadata?: {
        participantName?: string
        studyId?: string
        notes?: string
        [key: string]: unknown
    }
}

/**
 * Payload for the headset-identify event.
 */
interface HeadsetIdentifyPayload {
    /** The unique device identifier */
    deviceId: string
}

/**
 * Request body for starting a chunked upload.
 */
interface StartChunkedUploadPayload {
    /** Session timestamp identifier */
    timestamp: string | number
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
interface CompleteChunkedUploadPayload {
    /** The S3 multipart upload ID */
    uploadId: string
    /** The S3 object key */
    s3Key: string
    /** Array of uploaded parts with their ETags */
    parts: Array<{
        partNumber: number
        etag: string
    }>
}

/**
 * Request body for setting a device's custom name.
 */
interface SetDeviceNamePayload {
    /** The custom name to assign to the device */
    customName: string
}

/**
 * Payload for tablet sync metadata.
 */
interface TabletSyncMetadataPayload {
    /** The metadata JSON string */
    data: string
    /** Optional target device ID */
    targetDeviceId?: string
}

/**
 * Payload containing a session ID.
 */
interface SessionIdPayload {
    /** The session identifier */
    sessionId: string
}

// =============================================================================
// COMMON SCHEMAS
// =============================================================================

/**
 * Schema for validating device IDs.
 *
 * Requirements:
 * - Alphanumeric characters only (plus underscores and hyphens)
 * - Length: 1-64 characters
 * - Required field
 *
 * @example
 * ```typescript
 * const result = validate(deviceIdSchema, 'QUEST_001')
 * // result.value === 'QUEST_001'
 * ```
 */
export const deviceIdSchema: Schema = Joi.string()
    .pattern(/^[a-zA-Z0-9_-]{1,64}$/)
    .required()
    .messages({
        'string.pattern.base': 'Device ID must be alphanumeric (1-64 chars) with optional underscores/hyphens. Received invalid format.',
        'string.empty': 'Device ID is required but was empty. Please provide a valid device identifier.',
        'any.required': 'Device ID is required but was not provided. Please include the deviceId field.'
    })

/**
 * Schema for validating session IDs.
 *
 * Requirements:
 * - Alphanumeric characters (plus underscores, hyphens, and dots)
 * - Length: 1-100 characters
 * - Required field
 *
 * @example
 * ```typescript
 * const result = validate(sessionIdSchema, 'session_20250114_abc123')
 * // result.value === 'session_20250114_abc123'
 * ```
 */
export const sessionIdSchema: Schema = Joi.string()
    .pattern(/^[a-zA-Z0-9_.-]{1,100}$/)
    .required()
    .messages({
        'string.pattern.base': 'Session ID must be alphanumeric (1-100 chars) with optional underscores/hyphens/dots. Received invalid format.',
        'any.required': 'Session ID is required but was not provided. Please include the sessionId field.'
    })

/**
 * Schema for validating timestamps.
 *
 * Accepts:
 * - Unix timestamp in milliseconds (number, 13+ digits)
 * - ISO 8601 date string (YYYY-MM-DD format)
 *
 * @example
 * ```typescript
 * validate(timestampSchema, 1705234567890) // Unix timestamp
 * validate(timestampSchema, '2025-01-14T12:00:00Z') // ISO string
 * ```
 */
export const timestampSchema: Schema = Joi.alternatives().try(
    Joi.number().integer().positive(),
    Joi.string().pattern(/^\d{13,}$|^\d{4}-\d{2}-\d{2}/)
).required()

// =============================================================================
// SOCKET.IO EVENT SCHEMAS
// =============================================================================

/**
 * Schema for the tablet-lock-devices event payload.
 *
 * Validates an array of device IDs that a tablet wants to lock
 * for exclusive control.
 *
 * @example
 * ```typescript
 * const payload = { deviceIds: ['QUEST_001', 'QUEST_002'] }
 * const result = validate<LockDevicesPayload>(lockDevicesSchema, payload)
 * ```
 */
export const lockDevicesSchema: Schema = Joi.object({
    deviceIds: Joi.array()
        .items(deviceIdSchema)
        .min(1)
        .max(50)
        .required()
        .messages({
            'array.min': 'At least one device ID is required. Please provide an array with one or more device IDs.',
            'array.max': 'Cannot lock more than 50 devices at once. Please reduce the number of devices in your request.'
        })
})

/**
 * Schema for the tablet-create-session event payload.
 *
 * Validates session creation requests including device selection
 * and optional metadata.
 *
 * @example
 * ```typescript
 * const payload = {
 *   deviceIds: ['QUEST_001', 'QUEST_002'],
 *   metadata: { participantName: 'John Doe', studyId: 'STUDY_001' }
 * }
 * const result = validate<CreateSessionPayload>(createSessionSchema, payload)
 * ```
 */
export const createSessionSchema: Schema = Joi.object({
    deviceIds: Joi.array()
        .items(deviceIdSchema)
        .min(1)
        .max(50)
        .required(),
    metadata: Joi.object({
        participantName: Joi.string().max(100).optional(),
        studyId: Joi.string().max(50).optional(),
        notes: Joi.string().max(1000).optional()
    }).unknown(true).optional()
})

/**
 * Schema for the headset-identify event payload.
 *
 * Validates the device identification message sent by headsets
 * when they connect to the server.
 *
 * @example
 * ```typescript
 * const payload = { deviceId: 'QUEST_001' }
 * const result = validate<HeadsetIdentifyPayload>(headsetIdentifySchema, payload)
 * ```
 */
export const headsetIdentifySchema: Schema = Joi.object({
    deviceId: deviceIdSchema
})

/**
 * Schema for device telemetry payloads.
 *
 * Validates comprehensive telemetry data sent by headsets including
 * battery level, storage, WiFi signal, tracking status, and more.
 * Allows unknown fields for forward compatibility.
 *
 * @example
 * ```typescript
 * const telemetry = {
 *   deviceId: 'QUEST_001',
 *   batteryLevel: 85,
 *   isRecording: true,
 *   wifiSignalLevel: -45
 * }
 * const result = validate(deviceTelemetrySchema, telemetry)
 * ```
 */
export const deviceTelemetrySchema: Schema = Joi.object({
    deviceId: deviceIdSchema,
    deviceName: Joi.string().max(100).optional(),
    customName: Joi.string().max(100).allow('').optional(),
    timestamp: Joi.number().optional(),
    batteryLevel: Joi.number().min(0).max(100).optional(),
    batteryState: Joi.number().optional(),
    storageUsedBytes: Joi.number().min(0).optional(),
    storageTotalBytes: Joi.number().min(0).optional(),
    wifiSignalLevel: Joi.number().min(-100).max(0).optional(),
    wifiSSID: Joi.string().max(100).allow('').optional(),
    appVersion: Joi.string().max(50).optional(),
    osVersion: Joi.string().max(50).optional(),
    sdkVersion: Joi.string().max(50).optional(),
    leftHandTracked: Joi.boolean().optional(),
    rightHandTracked: Joi.boolean().optional(),
    bodyTracked: Joi.boolean().optional(),
    trackingConfidence: Joi.number().min(0).max(1).optional(),
    isRecording: Joi.boolean().optional(),
    sessionDuration: Joi.number().min(0).optional(),
    productiveTime: Joi.number().min(0).optional(),
    frameCount: Joi.number().integer().min(0).optional(),
    droppedFrames: Joi.number().integer().min(0).optional(),
    cpuTemperature: Joi.number().optional(),
    gpuTemperature: Joi.number().optional(),
    memoryUsedMB: Joi.number().min(0).optional(),
    memoryTotalMB: Joi.number().min(0).optional()
}).unknown(true) // Allow additional fields for forward compatibility

// =============================================================================
// REST API SCHEMAS
// =============================================================================

/**
 * Schema for starting a chunked upload request.
 *
 * Used to initiate a multipart upload to S3 for large files.
 * Maximum file size is 100GB.
 *
 * @example
 * ```typescript
 * const request = {
 *   timestamp: '20250114_120000',
 *   fileType: 'video',
 *   fileSize: 5368709120, // 5GB
 *   fileName: 'recording.mp4'
 * }
 * const result = validate<StartChunkedUploadPayload>(startChunkedUploadSchema, request)
 * ```
 */
export const startChunkedUploadSchema: Schema = Joi.object({
    timestamp: timestampSchema,
    fileType: Joi.string().valid('video', 'data').required().messages({
        'any.only': 'File type must be either "video" or "data". Received invalid file type.',
        'any.required': 'File type is required. Please specify "video" or "data".'
    }),
    fileSize: Joi.number().integer().positive().max(100 * 1024 * 1024 * 1024).required().messages({
        'number.max': 'File size exceeds maximum allowed (100GB). Please use a smaller file or split into multiple uploads.',
        'number.positive': 'File size must be a positive number. Received invalid file size.',
        'any.required': 'File size is required. Please specify the total size in bytes.'
    }),
    fileName: Joi.string().max(255).optional()
})

/**
 * Schema for completing a chunked upload request.
 *
 * Used to finalize a multipart upload by providing all part ETags.
 * Maximum 10,000 parts (S3 limit).
 *
 * @example
 * ```typescript
 * const request = {
 *   uploadId: 'abc123xyz',
 *   s3Key: 'sessions/20250114_120000/recording.mp4',
 *   parts: [
 *     { partNumber: 1, etag: '"abc123"' },
 *     { partNumber: 2, etag: '"def456"' }
 *   ]
 * }
 * const result = validate<CompleteChunkedUploadPayload>(completeChunkedUploadSchema, request)
 * ```
 */
export const completeChunkedUploadSchema: Schema = Joi.object({
    uploadId: Joi.string().required().messages({
        'any.required': 'Upload ID is required. This should be the ID returned from the start upload request.'
    }),
    s3Key: Joi.string().required().messages({
        'any.required': 'S3 key is required. This should be the key returned from the start upload request.'
    }),
    parts: Joi.array().items(
        Joi.object({
            partNumber: Joi.number().integer().positive().required().messages({
                'any.required': 'Part number is required for each part.',
                'number.positive': 'Part number must be a positive integer.'
            }),
            etag: Joi.string().required().messages({
                'any.required': 'ETag is required for each part. This is returned from S3 after uploading each chunk.'
            })
        })
    ).min(1).max(10000).required().messages({
        'array.min': 'At least one part is required to complete the upload.',
        'array.max': 'Maximum 10,000 parts allowed (S3 limit). Consider using larger chunk sizes.'
    })
})

/**
 * Schema for setting a device's custom name.
 *
 * Allows administrators to assign friendly names to devices
 * for easier identification.
 *
 * @example
 * ```typescript
 * const request = { customName: 'Lab Quest #1' }
 * const result = validate<SetDeviceNamePayload>(setDeviceNameSchema, request)
 * ```
 */
export const setDeviceNameSchema: Schema = Joi.object({
    customName: Joi.string().max(100).required().messages({
        'string.max': 'Custom name must be 100 characters or less.',
        'any.required': 'Custom name is required. Provide an empty string to clear the name.'
    })
})

/**
 * Schema for recording state payload.
 *
 * Simple boolean validation for recording state changes.
 *
 * @example
 * ```typescript
 * const result = validate(recordingStateSchema, true)
 * ```
 */
export const recordingStateSchema: Schema = Joi.boolean().required().messages({
    'boolean.base': 'Recording state must be a boolean (true or false).',
    'any.required': 'Recording state is required.'
})

/**
 * Schema for tablet sync metadata payload.
 *
 * Validates metadata synchronization requests from tablets
 * to headsets. Maximum 100KB of data.
 *
 * @example
 * ```typescript
 * const payload = {
 *   data: JSON.stringify({ participant: 'John', session: 1 }),
 *   targetDeviceId: 'QUEST_001'
 * }
 * const result = validate<TabletSyncMetadataPayload>(tabletSyncMetadataSchema, payload)
 * ```
 */
export const tabletSyncMetadataSchema: Schema = Joi.object({
    data: Joi.string().max(100000).required().messages({
        'string.max': 'Metadata too large. Maximum 100KB allowed.',
        'any.required': 'Metadata data field is required.'
    }),
    targetDeviceId: deviceIdSchema.optional()
})

/**
 * Schema for session ID payload.
 *
 * Used for requests that only contain a session ID reference.
 *
 * @example
 * ```typescript
 * const payload = { sessionId: 'session_20250114_abc123' }
 * const result = validate<SessionIdPayload>(sessionIdPayloadSchema, payload)
 * ```
 */
export const sessionIdPayloadSchema: Schema = Joi.object({
    sessionId: sessionIdSchema
})

/**
 * Schema for frame data validation.
 *
 * Validates base64-encoded image frames from headsets.
 * Maximum 1MB per frame.
 *
 * @example
 * ```typescript
 * const frameData = 'data:image/jpeg;base64,/9j/4AAQSkZJRg...'
 * const result = validate(frameDataSchema, frameData)
 * ```
 */
export const frameDataSchema: Schema = Joi.string().max(1024 * 1024).required().messages({
    'string.max': 'Frame data too large. Maximum 1MB allowed per frame.',
    'any.required': 'Frame data is required.'
})

/**
 * Schema for status data validation.
 *
 * Validates JSON status updates from headsets.
 * Maximum 10KB per status message.
 *
 * @example
 * ```typescript
 * const statusData = JSON.stringify({ tracking: 'active', fps: 72 })
 * const result = validate(statusDataSchema, statusData)
 * ```
 */
export const statusDataSchema: Schema = Joi.string().max(10000).required().messages({
    'string.max': 'Status data too large. Maximum 10KB allowed.',
    'any.required': 'Status data is required.'
})

// =============================================================================
// VALIDATION HELPER
// =============================================================================

/**
 * Validates data against a Joi schema and returns typed results.
 *
 * Performs validation with the following options:
 * - `abortEarly: false` - Collects all validation errors, not just the first
 * - `stripUnknown: true` - Removes unrecognized fields from the validated data
 *
 * @typeParam T - The expected type of the validated data
 * @param schema - The Joi schema to validate against
 * @param data - The data to validate (can be any type)
 * @returns An object containing either the validated value or an error message
 *
 * @example
 * ```typescript
 * // Successful validation
 * const result = validate<LockDevicesPayload>(lockDevicesSchema, { deviceIds: ['QUEST_001'] })
 * if (result.value) {
 *   console.log(result.value.deviceIds) // ['QUEST_001']
 * }
 *
 * // Failed validation
 * const result = validate(deviceIdSchema, '')
 * if (result.error) {
 *   console.log(result.error) // 'Device ID is required but was empty...'
 * }
 * ```
 */
export function validate<T>(schema: Schema, data: unknown): ValidationOutcome<T> {
    const validationResult: ValidationResult = schema.validate(data, {
        abortEarly: false,
        stripUnknown: true
    })

    if (validationResult.error) {
        const messages: string = validationResult.error.details.map(d => d.message).join('; ')
        return { error: messages }
    }

    return { value: validationResult.value as T }
}

/**
 * Creates a Socket.IO event handler wrapper that validates incoming payloads.
 *
 * Wraps an event handler function to automatically validate the payload
 * before calling the handler. If validation fails:
 * - Logs a warning with the validation error details
 * - If a callback function is provided (for acknowledgments), calls it with an error response
 * - Does not call the original handler
 *
 * @typeParam T - The expected type of the validated payload
 * @param schema - The Joi schema to validate the payload against
 * @param handler - The event handler function to wrap
 * @returns A wrapped handler function that validates input before processing
 *
 * @example
 * ```typescript
 * // Without validation wrapper
 * socket.on('tablet-lock-devices', (deviceIds) => {
 *   // Must manually validate deviceIds
 * })
 *
 * // With validation wrapper
 * socket.on('tablet-lock-devices', withValidation<LockDevicesPayload>(
 *   lockDevicesSchema,
 *   (payload) => {
 *     // payload.deviceIds is guaranteed to be valid
 *     console.log(payload.deviceIds)
 *   }
 * ))
 * ```
 */
export function withValidation<T>(
    schema: Schema,
    handler: (data: T, ...args: unknown[]) => void
): (data: unknown, ...args: unknown[]) => void {
    return (data: unknown, ...args: unknown[]): void => {
        const result: ValidationOutcome<T> = validate<T>(schema, data)

        if (result.error) {
            socketLogger.warn({ validationError: result.error }, 'Invalid payload received - validation failed')
            // If there's a callback (acknowledgment), call it with error
            const callback = args.find((arg): arg is (response: unknown) => void => typeof arg === 'function')
            callback?.({ ok: false, error: `Validation error: ${result.error}` })
            return
        }

        handler(result.value!, ...args)
    }
}

export default {
    deviceIdSchema,
    sessionIdSchema,
    timestampSchema,
    lockDevicesSchema,
    createSessionSchema,
    headsetIdentifySchema,
    deviceTelemetrySchema,
    startChunkedUploadSchema,
    completeChunkedUploadSchema,
    setDeviceNameSchema,
    validate,
    withValidation
}
