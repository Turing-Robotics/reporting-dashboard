# Quest VR Backend Data Schema Documentation

This document describes all data structures, interfaces, and schemas used by the Quest VR Backend system.

## Table of Contents

1. [TypeScript Interfaces](#typescript-interfaces)
   - [Device/Headset Data](#deviceheadset-data)
   - [Session Data](#session-data)
   - [Telemetry Data](#telemetry-data)
   - [Upload Data](#upload-data)
   - [Authentication Data](#authentication-data)
2. [Socket.IO Events](#socketio-events)
   - [Headset Events](#headset-events)
   - [Tablet Events](#tablet-events)
   - [Dashboard Events](#dashboard-events)
   - [Outbound Events](#outbound-events)
3. [S3 Data Organization](#s3-data-organization)
   - [Bucket Structure](#bucket-structure)
   - [File Formats](#file-formats)
   - [Naming Conventions](#naming-conventions)
4. [NPZ File Structure](#npz-file-structure)
5. [Redis Data Structures](#redis-data-structures)
6. [REST API Payloads](#rest-api-payloads)
7. [Validation Schemas](#validation-schemas)
8. [QA Metrics Structure](#qa-metrics-structure)

---

## TypeScript Interfaces

### Device/Headset Data

#### DeviceState
Represents the current state of a connected VR headset device.

```typescript
interface DeviceState {
    /** Unique device identifier (e.g., Quest serial number) */
    deviceId: string;

    /** Current Socket.IO socket ID for this device */
    socketId: string;

    /** Whether the device is currently connected */
    isOnline: boolean;

    /** Timestamp of last activity */
    lastSeen: Date;

    /** Latest telemetry data from the device */
    telemetry: DeviceTelemetry | null;

    /** When the device first connected in this session */
    connectionTime: Date;

    /** Socket ID of tablet that has exclusive control (if locked) */
    lockedByTabletId?: string;

    /** When the device was locked */
    lockedAt?: Date;
}
```

#### DeviceTelemetry
Comprehensive telemetry data sent by VR headsets.

```typescript
interface DeviceTelemetry {
    /** Unique device identifier */
    deviceId: string;

    /** System device name */
    deviceName: string;

    /** User-assigned custom name */
    customName?: string;

    /** Unix timestamp (milliseconds) */
    timestamp: number;

    // === Battery ===
    /** Battery level (0.0 - 1.0) */
    batteryLevel: number;

    /** Battery charging state (0=unknown, 1=charging, 2=discharging, 3=not charging, 4=full) */
    batteryState: number;

    // === Storage ===
    /** Used storage in bytes */
    storageUsedBytes: number;

    /** Total storage capacity in bytes */
    storageTotalBytes: number;

    // === Network ===
    /** WiFi signal strength in dBm (-100 to 0) */
    wifiSignalLevel: number;

    /** Connected WiFi network name */
    wifiSSID: string;

    // === Software Versions ===
    /** Application version string */
    appVersion: string;

    /** Operating system version */
    osVersion: string;

    /** SDK version */
    sdkVersion: string;

    // === Tracking Status ===
    /** Whether left hand is currently tracked */
    leftHandTracked: boolean;

    /** Whether right hand is currently tracked */
    rightHandTracked: boolean;

    /** Whether body tracking is active */
    bodyTracked: boolean;

    /** Overall tracking confidence (0.0 - 1.0) */
    trackingConfidence: number;

    // === Recording Status ===
    /** Whether device is currently recording */
    isRecording: boolean;

    /** Current session duration in seconds */
    sessionDuration: number;

    /** Accumulated productive time in seconds */
    productiveTime: number;

    /** Total frames captured in current session */
    frameCount: number;

    /** Frames dropped due to performance issues */
    droppedFrames: number;

    // === System Health ===
    /** CPU temperature in Celsius */
    cpuTemperature: number;

    /** GPU temperature in Celsius */
    gpuTemperature: number;

    /** Used memory in megabytes */
    memoryUsedMB: number;

    /** Total memory in megabytes */
    memoryTotalMB: number;
}
```

#### HeadsetListInfo
Summary info for headset list broadcasts.

```typescript
interface HeadsetListInfo {
    /** Unique device identifier */
    deviceId: string;

    /** Whether device is locked by a tablet */
    isLocked: boolean;

    /** Socket ID of locking tablet (if locked) */
    lockedByTabletId?: string;

    /** User-assigned custom name */
    customName: string;
}
```

#### DeviceLockStatus
Lock status for broadcasting to all clients.

```typescript
interface DeviceLockStatus {
    /** Unique device identifier */
    deviceId: string;

    /** Whether device is currently locked */
    isLocked: boolean;

    /** Socket ID of tablet holding the lock */
    lockedByTabletId?: string;
}
```

---

### Session Data

#### CaptureSession
Represents a multi-device recording session.

```typescript
interface CaptureSession {
    /** Unique session identifier (format: session_{timestamp}_{socketIdPrefix}) */
    sessionId: string;

    /** Socket ID of the tablet that created this session */
    tabletId: string;

    /** Array of device IDs participating in this session */
    deviceIds: string[];

    /** Current session status */
    status: 'pending' | 'recording' | 'paused' | 'completed' | 'uploading';

    /** When the session was created */
    createdAt: Date;

    /** When recording started */
    startedAt?: Date;

    /** When session ended */
    endedAt?: Date;

    /** Optional metadata (participant info, study ID, notes) */
    metadata?: Record<string, unknown>;

    /** Per-device status tracking */
    deviceStatuses: Map<string, DeviceSessionStatus>;
}

interface DeviceSessionStatus {
    /** Whether this device is currently recording */
    isRecording: boolean;

    /** Number of frames captured */
    frameCount: number;

    /** Upload progress (0-100) */
    uploadProgress: number;

    /** Upload status */
    uploadStatus: 'pending' | 'uploading' | 'completed' | 'failed';
}
```

---

### Upload Data

#### StartChunkedUploadRequest
Request to initiate a chunked S3 upload.

```typescript
interface StartChunkedUploadRequest {
    /** Session timestamp identifier (YYYYMMDD_HHMMSS format) */
    timestamp: string;

    /** Type of file being uploaded */
    fileType: 'video' | 'data';

    /** Total file size in bytes */
    fileSize: number;

    /** Optional original filename */
    fileName?: string;
}
```

#### CompleteChunkedUploadRequest
Request to finalize a chunked upload.

```typescript
interface CompleteChunkedUploadRequest {
    /** S3 multipart upload ID */
    uploadId: string;

    /** S3 object key */
    s3Key: string;

    /** Array of uploaded parts with ETags */
    parts: Array<{
        /** Part number (1-indexed) */
        partNumber: number;

        /** ETag returned from S3 for this part */
        etag: string;
    }>;
}
```

#### UploadSessionBody
Legacy single-request upload body.

```typescript
type UploadSessionBody = {
    /** Optional session identifier */
    sessionId?: string;

    /** Required timestamp for S3 path */
    timestamp?: string;
}
```

#### MulterS3File
Extended file type for S3 uploads.

```typescript
type MulterS3File = Express.Multer.File & {
    /** S3 bucket name */
    bucket: string;

    /** S3 object key */
    key: string;

    /** Full S3 URL */
    location: string;

    /** Object ETag */
    etag: string;
}
```

---

### Authentication Data

#### DeviceAuth
JWT payload for device authentication.

```typescript
interface DeviceAuth {
    /** Unique device identifier */
    deviceId: string;

    /** Type of device */
    deviceType: 'headset' | 'tablet' | 'dashboard';

    /** JWT issued-at timestamp */
    iat?: number;

    /** JWT expiration timestamp */
    exp?: number;
}
```

#### AuthenticatedSocket
Socket.IO socket with authentication data.

```typescript
interface AuthenticatedSocket extends Socket {
    data: {
        /** Authenticated device ID */
        deviceId: string;

        /** Device type */
        deviceType: 'headset' | 'tablet' | 'dashboard';

        /** Whether authentication succeeded */
        authenticated: boolean;
    };
}
```

---

## Socket.IO Events

### Headset Events (Client to Server)

| Event | Payload | Description |
|-------|---------|-------------|
| `headset-identify` | `deviceId: string` | Register headset with unique identifier |
| `headset-frame` | `data: string` (base64 JPEG) | Send video frame (max 1MB) |
| `headset-status` | `data: string` (JSON) | Send status update (max 10KB) |
| `device-telemetry` | `DeviceTelemetry \| string` | Send comprehensive telemetry |
| `headset-logs-processed` | (none) | Notify logs have been processed |
| `headset-recording-state` | `recording: boolean` | Notify recording state change |

### Tablet Events (Client to Server)

#### Device Locking

| Event | Payload | Description |
|-------|---------|-------------|
| `tablet-lock-device` | `deviceId: string` | Request exclusive lock on single device |
| `tablet-unlock-device` | `deviceId: string` | Release lock on single device |
| `tablet-lock-devices` | `deviceIds: string[]` | Lock multiple devices atomically |
| `tablet-unlock-all-devices` | (none) | Release all held locks |

#### Recording Control

| Event | Payload | Description |
|-------|---------|-------------|
| `tablet-start-recording` | `deviceId: string` | Start recording on specific device |
| `tablet-stop-recording` | `deviceId: string` | Stop recording on specific device |
| `tablet-start-all-recording` | (none) | Start recording on all locked devices |
| `tablet-stop-all-recording` | (none) | Stop recording on all locked devices |
| `tablet-toggle-recording` | `headsetId: string` | **DEPRECATED** - Toggle recording |
| `tablet-toggle-all-recording` | (none) | **DEPRECATED** - Toggle all |

#### Session Management

| Event | Payload | Description |
|-------|---------|-------------|
| `tablet-create-session` | `{ deviceIds: string[], metadata?: object }` | Create new capture session |
| `tablet-start-session` | `sessionId: string` | Start recording for session |
| `tablet-pause-session` | `sessionId: string` | Pause session recording |
| `tablet-end-session` | `sessionId: string` | End session and stop recording |
| `tablet-get-session` | `sessionId: string` | Request session status |
| `tablet-get-active-session` | (none) | Get tablet's active session |

#### Legacy Events

| Event | Payload | Description |
|-------|---------|-------------|
| `tablet-connect-headset` | `headsetId: string` | Legacy single-device connection |
| `tablet-disconnect-headset` | `headsetId: string` | Legacy single-device disconnection |
| `tablet-get-recording-status` | `headsetId: string` | Query recording status |
| `tablet-sync-metadata` | `data: string, targetDeviceId?: string` | Sync metadata to device(s) |

### Dashboard Events (Client to Server)

| Event | Payload | Description |
|-------|---------|-------------|
| `dashboard-subscribe` | (none) | Subscribe to fleet updates |
| `dashboard-unsubscribe` | (none) | Unsubscribe from fleet updates |

### Outbound Events (Server to Client)

#### Headset Notifications

| Event | Payload | Description |
|-------|---------|-------------|
| `on-headset-connected` | (none) | Confirmation of connection |
| `on-headset-disconnected` | (none) | Device disconnected |
| `on-headset-frame-updated` | `data: string` | Frame broadcast to room |
| `on-headset-status-updated` | `data: string` | Status broadcast to room |
| `on-headset-logs-processed` | (none) | Logs processed notification |
| `on-headset-recording-active` | (none) | Recording started (legacy) |
| `on-headset-recording-inactive` | (none) | Recording stopped (legacy) |

#### Headset List Updates

| Event | Payload | Description |
|-------|---------|-------------|
| `on-headsets-updated` | `string[]` | List of online device IDs (legacy) |
| `on-headsets-with-lock-status-updated` | `HeadsetListInfo[]` | Full headset info with lock status |
| `on-device-locks-updated` | `DeviceLockStatus[]` | Lock status broadcast |

#### Device Lock Responses

| Event | Payload | Description |
|-------|---------|-------------|
| `on-device-locked` | `{ deviceId: string }` | Lock acquired |
| `on-device-lock-failed` | `{ deviceId: string, reason: string }` | Lock failed |
| `on-device-unlocked` | `{ deviceId: string }` | Lock released |
| `on-devices-locked` | `{ locked: string[], failed: string[] }` | Batch lock result |
| `on-all-devices-unlocked` | `{ unlocked: string[] }` | All locks released |
| `on-device-disconnected` | `{ deviceId: string }` | Locked device went offline |

#### Recording Notifications

| Event | Payload | Description |
|-------|---------|-------------|
| `on-tablet-recording-toggled` | (none) | Toggle recording command |
| `on-tablet-start-recording` | (none) | Start recording command |
| `on-tablet-stop-recording` | (none) | Stop recording command |
| `on-device-recording-changed` | `{ deviceId: string, isRecording: boolean }` | Recording state changed |
| `on-recording-denied` | `{ deviceId: string }` | Recording control denied |
| `on-recording-toggle-denied` | `{ deviceId: string }` | Toggle denied (deprecated) |

#### Session Notifications

| Event | Payload | Description |
|-------|---------|-------------|
| `on-session-created` | `{ sessionId, deviceIds, unavailable? }` | Session created |
| `on-session-started` | `{ sessionId, startedAt }` | Session recording started |
| `on-session-paused` | `{ sessionId }` | Session paused |
| `on-session-ended` | `{ sessionId, endedAt, duration }` | Session ended |
| `on-session-error` | `{ error, sessionId?, unavailable? }` | Session error |
| `on-session-status` | `{ sessionId, status, deviceIds, ... }` | Session status response |
| `on-active-session` | `{ sessionId, status, deviceIds } \| null` | Active session response |

#### Dashboard Updates

| Event | Payload | Description |
|-------|---------|-------------|
| `on-fleet-status-updated` | `DeviceState[]` | Initial fleet status |
| `on-device-telemetry-updated` | `{ deviceId, isOnline, lastSeen, telemetry, isLocked, lockedByTabletId }` | Telemetry update |

---

## S3 Data Organization

### Bucket Structure

```
s3://turing-robotics-datahub/
├── sessions/
│   ├── {YYYYMMDD_HHMMSS}/           # Session timestamp folder
│   │   ├── recording.mp4            # Video file (H.264)
│   │   └── session_data.npz         # NumPy compressed data
│   │
│   └── {YYYYMMDD_HHMMSS}/
│       ├── recording.mp4
│       └── session_data.npz
│
└── client_output/                    # Processed outputs
    └── *.zip                         # Output packages
```

### File Formats

| File Type | Extension | Content Type | Description |
|-----------|-----------|--------------|-------------|
| Video | `.mp4` | `video/mp4` | H.264 encoded recording |
| Session Data | `.npz` | `application/octet-stream` | NumPy compressed arrays |
| Processed Output | `.zip` | `application/zip` | Client output packages |

### Naming Conventions

- **Session Timestamp**: `YYYYMMDD_HHMMSS` (e.g., `20260206_143052`)
- **Video File**: Always `recording.mp4`
- **Data File**: Always `session_data.npz`
- **S3 Key Pattern**: `sessions/{timestamp}/{filename}`

### Session ID Pattern Validation

```typescript
const SESSION_ID_PATTERN = /^\d{8}_\d{6}$/;
// Valid: "20260206_143052"
// Invalid: "session_123", "2026-02-06_14:30:52"
```

---

## NPZ File Structure

The `.npz` file contains NumPy arrays for tracking and quality data.

### Arrays

| Key | Type | Shape | Description |
|-----|------|-------|-------------|
| `left_confidence` | `float32[]` | `(n_frames,)` | Left hand tracking confidence (0.0-1.0) |
| `right_confidence` | `float32[]` | `(n_frames,)` | Right hand tracking confidence (0.0-1.0) |
| `left_tracked` | `bool[]` | `(n_frames,)` | Whether left hand was tracked |
| `right_tracked` | `bool[]` | `(n_frames,)` | Whether right hand was tracked |
| `both_hands_not_in_frame` | `bool[]` | `(n_frames,)` | Both hands missing flag |
| `hand_speed_exceeded` | `bool[]` | `(n_frames,)` | Hand speed threshold exceeded |
| `tracking_errors` | `bool[]` | `(n_frames,)` | Tracking error flag |
| `metadata` | `bytes[]` | `(1,)` | JSON-encoded session metadata |

### Metadata JSON Structure

```json
{
  "capture_date": "2026-02-06T14:30:52Z",
  "success": true,
  "device_id": "QUEST_001",
  "app_version": "2.3.0",
  "duration_seconds": 120,
  "total_frames": 7200
}
```

### Python Parsing Example

```python
import numpy as np
import json

npz = np.load('session_data.npz', allow_pickle=True)

# Access arrays
left_conf = npz['left_confidence']
right_conf = npz['right_confidence']

# Parse metadata
metadata_bytes = npz['metadata'][0]
metadata = json.loads(metadata_bytes.decode('utf-8'))

print(f"Frames: {len(left_conf)}")
print(f"Capture Date: {metadata['capture_date']}")
```

---

## Redis Data Structures

### RedisDeviceState

```typescript
interface RedisDeviceState {
    deviceId: string;
    socketId: string;
    isOnline: boolean;          // Stored as "1" or "0"
    lastSeen: string;           // ISO 8601 timestamp
    connectionTime: string;     // ISO 8601 timestamp
    lockedByTabletId?: string;
    lockedAt?: string;          // ISO 8601 timestamp
}
```

**Redis Key**: `device:{deviceId}`
**Type**: Hash
**TTL**: 24 hours

### RedisSessionState

```typescript
interface RedisSessionState {
    sessionId: string;
    tabletId: string;
    deviceIds: string[];        // Stored as JSON array
    status: 'pending' | 'recording' | 'paused' | 'completed' | 'uploading';
    createdAt: string;          // ISO 8601 timestamp
    startedAt?: string;
    endedAt?: string;
    metadata?: string;          // JSON-encoded
}
```

**Redis Key**: `session:{sessionId}`
**Type**: Hash
**TTL**: 7 days

### Device Locks

| Key Pattern | Type | TTL | Description |
|-------------|------|-----|-------------|
| `lock:{deviceId}` | String | 2 hours | Tablet socket ID holding lock |
| `tablet_locks:{tabletId}` | Set | none | Device IDs locked by tablet |

### Telemetry Cache

**Redis Key**: `telemetry:{deviceId}`
**Type**: String (JSON)
**TTL**: 5 minutes

---

## REST API Payloads

### Device Token Request

```typescript
// POST /auth/device-token
interface DeviceTokenRequest {
    deviceId: string;    // 8-64 alphanumeric chars
    deviceType: 'headset' | 'tablet' | 'dashboard';
}

// Response
interface DeviceTokenResponse {
    ok: true;
    token: string;       // JWT token
    deviceId: string;
    deviceType: string;
    expiresIn: string;   // "24h"
}
```

### Fleet Summary

```typescript
// GET /api/fleet/summary
interface FleetSummary {
    ok: true;
    summary: {
        totalDevices: number;
        onlineDevices: number;
        offlineDevices: number;
        recordingDevices: number;
        lowBatteryDevices: number;  // Battery < 25%
        lockedDevices: number;
        avgBatteryLevel: number;    // 0.0 - 1.0
        totalProductiveTime: number; // Seconds
        appVersions: string[];
    };
}
```

### Device List

```typescript
// GET /api/devices
interface DeviceListResponse {
    ok: true;
    count: number;
    devices: Array<{
        deviceId: string;
        isOnline: boolean;
        lastSeen: string;          // ISO timestamp
        connectionTime: string;    // ISO timestamp
        telemetry: DeviceTelemetry | null;
        isLocked: boolean;
        lockedByTabletId?: string;
    }>;
}
```

### Chunked Upload Start Response

```typescript
// POST /chunked-upload/start
interface ChunkedUploadStartResponse {
    ok: true;
    uploadId: string;
    s3Key: string;
    totalParts: number;
    chunkSize: number;          // 10MB (10485760)
    presignedUrls: Array<{
        partNumber: number;
        url: string;
    }>;
}
```

---

## Validation Schemas

### Device ID
- Pattern: `/^[a-zA-Z0-9_-]{1,64}$/`
- Length: 1-64 characters
- Characters: Alphanumeric, underscore, hyphen

### Session ID
- Pattern: `/^[a-zA-Z0-9_.-]{1,100}$/`
- Length: 1-100 characters
- Characters: Alphanumeric, underscore, hyphen, dot

### Timestamp
- Unix milliseconds: 13+ digit number
- ISO 8601: `YYYY-MM-DD...` format

### File Size Limits
- Max file size: 100GB
- Max chunk count: 10,000
- Chunk size: 10MB
- Frame data: Max 1MB per frame
- Status data: Max 10KB
- Metadata sync: Max 100KB

### Batch Limits
- Max devices per lock request: 50
- Max session devices: 50

---

## QA Metrics Structure

### QAMetrics

```typescript
interface QAMetrics {
    overview: {
        totalSessions: number;
        completeSessions: number;
        lastUpdated: string;     // ISO timestamp
    };

    sessions: Array<{
        sessionId: string;
        captureDate: string;
        status: string;

        stages: {
            stage2_captureQuality: {
                totalFrames: number;
                bothHandsNotInFramePercent: number;
                trackingErrorsPercent: number;
                handSpeedExceededPercent: number;
                validFramesPercent: number;
                score: number;   // 0-100
            };

            stage10_validationTests: {
                npzIntegrityCheck: boolean;
                frameCountCheck: boolean;
                timestampConsistency: boolean;
                score: number;   // 0-100
            };

            stage12_trackingConfidence: {
                leftHandAvgConfidence: number;
                rightHandAvgConfidence: number;
                overallAvgConfidence: number;
                lowConfidenceFramesPercent: number;
                score: number;   // 0-100
            };
        };

        overallQualityScore: number;  // 0-100
    }>;

    aggregateStats: {
        avgCaptureQuality: number;
        avgTrackingConfidence: number;
        avgValidationScore: number;
        sessionsWithIssues: number;   // Quality < 80%
    };
}
```

### Quality Score Calculation

```
Overall = (CaptureQuality * 0.4) + (ValidationScore * 0.3) + (TrackingConfidence * 0.3)

CaptureQuality = 100 - bothHandsNotInFrame% - trackingErrors% - handSpeedExceeded%
ValidationScore = (npzIntegrity ? 33.33 : 0) + (frameCount ? 33.33 : 0) + (timestamps ? 33.34 : 0)
TrackingConfidence = overallAvgConfidence * 100
```

---

## S3 Statistics Structure

```typescript
interface S3Stats {
    overview: {
        totalFiles: number;
        totalSizeGB: number;
        totalSizeBytes: number;
        averageFileSizeMB: number;
        lastUpdated: string;
    };

    byType: {
        [extension: string]: {
            count: number;
            sizeGB: number;
            percentage: number;
        };
    };

    sessions: {
        total: number;
        complete: number;      // Has both .mp4 and .npz
        incomplete: number;
        sessions: Array<{
            id: string;
            files: number;
            sizeGB: number;
            hasMp4: boolean;
            hasNpz: boolean;
            status: 'complete' | 'incomplete';
        }>;
    };

    processedOutputs: {
        count: number;
        sizeGB: number;
        files: Array<{
            name: string;
            sizeGB: number;
            date: string;
        }>;
    };

    timeline: Array<{
        date: string;
        files: number;
        sizeGB: number;
        mp4Count: number;
        npzCount: number;
        zipCount: number;
    }>;

    costs: {
        currentMonthly: number;      // Standard tier
        intelligentTiering: number;
        glacierDeepArchive: number;
        costPerSession: number;
    };

    insights: {
        videoStats: {
            count: number;
            minGB: number;
            maxGB: number;
            avgGB: number;
            medianGB: number;
        };
        npzStats: {
            count: number;
            minMB: number;
            maxMB: number;
            avgMB: number;
            medianMB: number;
        };
    };
}
```

---

## Prometheus Metrics

The backend exposes the following metrics at `/metrics`:

### Device Metrics
- `turing_connected_devices_total{type}` - Connected devices (gauge)
- `turing_locked_devices_total` - Locked devices (gauge)
- `turing_recording_devices_total` - Recording devices (gauge)
- `turing_device_connections_total{type,event}` - Connection events (counter)
- `turing_device_lock_operations_total{operation,success}` - Lock operations (counter)

### Session Metrics
- `turing_sessions_active_total` - Active sessions (gauge)
- `turing_sessions_created_total` - Sessions created (counter)
- `turing_session_duration_seconds` - Session duration (histogram)

### Upload Metrics
- `turing_upload_duration_seconds{file_type}` - Upload duration (histogram)
- `turing_upload_size_bytes{file_type}` - Upload size (histogram)
- `turing_upload_errors_total{error_type}` - Upload errors (counter)
- `turing_uploads_in_progress` - Active uploads (gauge)
- `turing_upload_bytes_total{file_type}` - Total bytes uploaded (counter)

### Socket.IO Metrics
- `turing_socket_messages_total{event_type,direction}` - Socket messages (counter)
- `turing_socket_events_total{event}` - Events by type (counter)
- `turing_frame_batch_size` - Frame batch sizes (histogram)
- `turing_frames_dropped_total` - Dropped frames (counter)

### Fleet Metrics
- `turing_fleet_battery_level{device_id}` - Battery level per device (gauge)
- `turing_low_battery_devices_total` - Devices with low battery (gauge)
- `turing_dashboard_subscribers_total` - Dashboard subscribers (gauge)

---

## Configuration Constants

```typescript
// Upload limits
const CHUNK_SIZE = 10 * 1024 * 1024;           // 10MB per chunk
const MAX_CHUNKS = 10000;                       // S3 limit
const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20GB per file

// Real-time optimization
const FRAME_BATCH_INTERVAL_MS = 33;            // ~30 batches/sec
const FRAME_THROTTLE_MS = 16;                  // Max ~60fps per headset
const MAX_FRAME_BATCH_SIZE = 5;                // Prevent memory growth

// Cleanup intervals
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;      // Hourly
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;           // 24 hours
const OFFLINE_DEVICE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Redis TTLs
const DEVICE_STATE_TTL = 3600 * 24;            // 24 hours
const LOCK_TTL = 7200;                         // 2 hours
const SESSION_TTL = 3600 * 24 * 7;             // 7 days
const TELEMETRY_TTL = 300;                     // 5 minutes
```

---

## Document Version

- **Last Updated**: 2026-02-06
- **Backend Version**: 2.3
- **Source**: `/Users/pavly/Downloads/Aria/Server/backup_20260206/quest_backend/`
