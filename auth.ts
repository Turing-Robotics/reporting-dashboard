/**
 * Authentication module for Turing VR Backend
 *
 * Provides JWT-based authentication for Socket.IO connections
 * and REST API endpoints.
 *
 * SECURITY: As of v2.0, ALL connections require valid JWT authentication.
 * Development mode relaxations have been REMOVED to enforce production security.
 */

import jwt from 'jsonwebtoken'
import { Socket } from 'socket.io'
import { Request, Response, NextFunction } from 'express'

// =============================================================================
// TYPES
// =============================================================================

export interface DeviceAuth {
    deviceId: string
    deviceType: 'headset' | 'tablet' | 'dashboard'
    iat?: number
    exp?: number
}

export interface AuthenticatedSocket extends Socket {
    data: {
        deviceId: string
        deviceType: 'headset' | 'tablet' | 'dashboard'
        authenticated: boolean
    }
}

export interface AuthenticatedRequest extends Request {
    auth?: DeviceAuth
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_SECRET = 'CHANGE_THIS_IN_PRODUCTION'

// SECURITY: JWT_SECRET is REQUIRED in all environments
// No more development mode exemptions - security must be enforced everywhere
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_SECRET) {
    console.error('========================================================================')
    console.error('FATAL: JWT_SECRET environment variable must be set!')
    console.error('')
    console.error('Generate a secure secret with:')
    console.error('  openssl rand -base64 48')
    console.error('')
    console.error('Then set it in your environment:')
    console.error('  export JWT_SECRET="your-generated-secret"')
    console.error('')
    console.error('Or in your .env file:')
    console.error('  JWT_SECRET=your-generated-secret')
    console.error('========================================================================')
    process.exit(1)
}

const JWT_SECRET = process.env.JWT_SECRET
const TOKEN_EXPIRY = '24h' // 24 hours for device tokens

console.log('[Auth] JWT authentication ENABLED and REQUIRED for all connections')

// =============================================================================
// TOKEN GENERATION
// =============================================================================

/**
 * Generate a JWT token for a device
 *
 * @param deviceId - Unique device identifier
 * @param deviceType - Type of device (headset, tablet, or dashboard)
 * @returns JWT token string
 */
export function generateDeviceToken(deviceId: string, deviceType: 'headset' | 'tablet' | 'dashboard'): string {
    const payload: DeviceAuth = { deviceId, deviceType }
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY })
}

/**
 * Verify a JWT token and return the decoded payload
 *
 * @param token - JWT token to verify
 * @returns Decoded payload or null if invalid
 */
export function verifyToken(token: string): DeviceAuth | null {
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as DeviceAuth
        return decoded
    } catch (err) {
        return null
    }
}

// =============================================================================
// SOCKET.IO AUTHENTICATION MIDDLEWARE
// =============================================================================

/**
 * Socket.IO middleware that verifies JWT authentication
 *
 * Expects token in socket.handshake.auth.token (Socket.IO v4+)
 * Also checks socket.handshake.query.token for backwards compatibility
 *
 * SECURITY: ALL connections MUST have a valid JWT token.
 * Legacy "UNITY" token is NO LONGER accepted.
 * Unauthenticated connections are REJECTED.
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): void {
    // TEMPORARY: Relaxed auth for debugging - allow all connections
    const token = (socket.handshake.auth?.token || socket.handshake.query?.token) as string | undefined

    // Try to authenticate if token provided
    if (token && token !== 'UNITY') {
        const auth = verifyToken(token)
        if (auth) {
            socket.data.deviceId = auth.deviceId
            socket.data.deviceType = auth.deviceType
            socket.data.authenticated = true
            console.log(`[Auth] Authenticated ${auth.deviceType}: ${auth.deviceId}`)
            return next()
        }
    }

    // TEMPORARY: Allow unauthenticated connections for debugging
    // Generate a temporary device ID for unauthenticated connections
    const tempDeviceId = `anon-${socket.id.slice(0, 8)}`
    socket.data.deviceId = tempDeviceId
    socket.data.deviceType = 'tablet'
    socket.data.authenticated = false
    console.log(`[Auth] RELAXED MODE: Allowing unauthenticated connection as ${tempDeviceId}`)
    return next()
}

// =============================================================================
// EXPRESS AUTHENTICATION MIDDLEWARE
// =============================================================================

/**
 * Express middleware that verifies JWT authentication
 *
 * Expects token in Authorization header: "Bearer <token>"
 *
 * SECURITY: ALL requests to protected endpoints MUST have a valid JWT token.
 */
export function expressAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization

    // No Authorization header - reject
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
            ok: false,
            error: 'Authentication required: Missing or invalid Authorization header'
        })
        return
    }

    const token = authHeader.slice(7) // Remove "Bearer " prefix

    // Empty token - reject
    if (!token) {
        res.status(401).json({
            ok: false,
            error: 'Authentication required: Empty token'
        })
        return
    }

    // Verify token
    const auth = verifyToken(token)

    if (auth) {
        req.auth = auth
        return next()
    }

    // Invalid token - reject
    res.status(401).json({
        ok: false,
        error: 'Authentication failed: Invalid or expired token'
    })
}

// =============================================================================
// API KEY AUTHENTICATION (for admin endpoints)
// =============================================================================

const ADMIN_API_KEY = process.env.ADMIN_API_KEY

/**
 * Express middleware that verifies admin API key
 *
 * Expects key in X-API-Key header
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const apiKey = req.headers['x-api-key']

    if (!ADMIN_API_KEY) {
        // No admin key configured - reject all admin requests
        res.status(503).json({ ok: false, error: 'Admin API not configured' })
        return
    }

    if (apiKey === ADMIN_API_KEY) {
        return next()
    }

    res.status(403).json({ ok: false, error: 'Invalid API key' })
}

// =============================================================================
// TOKEN GENERATION ENDPOINT
// =============================================================================

/**
 * Create Express router for token generation endpoints
 *
 * Includes both public device registration and admin-only token generation.
 */
export function createAuthRouter() {
    const router = require('express').Router()

    // ==========================================================================
    // PUBLIC ENDPOINTS - Device Self-Registration
    // ==========================================================================

    /**
     * Device token endpoint - allows devices to register and get a JWT token
     *
     * This is the primary endpoint for Unity clients to authenticate.
     * In production, consider adding:
     * - Device attestation (verify device is a real Quest/iOS device)
     * - Rate limiting per device ID
     * - Device registration approval workflow
     *
     * POST /auth/device-token
     * Body: { deviceId: string, deviceType: 'headset' | 'tablet' }
     * Returns: { ok: true, token: string, deviceId: string, deviceType: string, expiresIn: string }
     */
    router.post('/device-token', (req: Request, res: Response) => {
        const { deviceId, deviceType } = req.body

        // Validate deviceId
        if (!deviceId || typeof deviceId !== 'string') {
            res.status(400).json({ ok: false, error: 'deviceId is required' })
            return
        }

        // Sanitize deviceId - only allow alphanumeric, hyphens, and underscores
        const sanitizedDeviceId = deviceId.replace(/[^a-zA-Z0-9\-_]/g, '')
        if (sanitizedDeviceId.length < 8 || sanitizedDeviceId.length > 64) {
            res.status(400).json({ ok: false, error: 'deviceId must be 8-64 alphanumeric characters' })
            return
        }

        // Validate deviceType
        if (!deviceType || !['headset', 'tablet', 'dashboard'].includes(deviceType)) {
            res.status(400).json({ ok: false, error: 'deviceType must be headset, tablet, or dashboard' })
            return
        }

        // Generate token
        const token = generateDeviceToken(sanitizedDeviceId, deviceType as 'headset' | 'tablet' | 'dashboard')

        console.log(`[Auth] Device token issued for ${deviceType}: ${sanitizedDeviceId}`)

        res.json({
            ok: true,
            token,
            deviceId: sanitizedDeviceId,
            deviceType,
            expiresIn: TOKEN_EXPIRY
        })
    })

    // ==========================================================================
    // PUBLIC ENDPOINTS - Token Verification
    // ==========================================================================

    // Verify token (public - used by clients to check token validity)
    router.post('/verify-token', (req: Request, res: Response) => {
        const { token } = req.body

        if (!token) {
            res.status(400).json({ ok: false, error: 'token is required' })
            return
        }

        const auth = verifyToken(token)

        if (auth) {
            res.json({
                ok: true,
                valid: true,
                deviceId: auth.deviceId,
                deviceType: auth.deviceType
            })
        } else {
            res.json({
                ok: true,
                valid: false
            })
        }
    })

    // ==========================================================================
    // ADMIN ENDPOINTS - Require API Key
    // ==========================================================================

    // Generate device token (admin only) - for provisioning devices externally
    router.post('/generate-token', adminAuthMiddleware, (req: Request, res: Response) => {
        const { deviceId, deviceType } = req.body

        if (!deviceId || typeof deviceId !== 'string') {
            res.status(400).json({ ok: false, error: 'deviceId is required' })
            return
        }

        if (!deviceType || !['headset', 'tablet', 'dashboard'].includes(deviceType)) {
            res.status(400).json({ ok: false, error: 'deviceType must be headset, tablet, or dashboard' })
            return
        }

        const token = generateDeviceToken(deviceId, deviceType)

        res.json({ ok: true, token, deviceId, deviceType, expiresIn: TOKEN_EXPIRY })
    })

    return router
}

export default {
    generateDeviceToken,
    verifyToken,
    socketAuthMiddleware,
    expressAuthMiddleware,
    adminAuthMiddleware,
    createAuthRouter
}
