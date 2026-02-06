#!/bin/bash
# =============================================================================
# Generate nginx.conf from template
# =============================================================================
# This script generates the actual nginx.conf file from the template by
# substituting environment variables.
#
# Usage:
#   ./scripts/generate-nginx-config.sh [options]
#
# Options:
#   --env-file FILE    Load environment variables from file (default: .env)
#   --output FILE      Output file path (default: /etc/nginx/sites-available/default)
#   --dry-run          Print generated config to stdout without writing
#   --validate         Validate the generated configuration with nginx -t
#   --reload           Reload nginx after generating config
#   --help             Show this help message
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEMPLATE_FILE="${PROJECT_ROOT}/config/nginx.conf.template"

# Default values
ENV_FILE="${PROJECT_ROOT}/.env"
OUTPUT_FILE="/etc/nginx/sites-available/default"
DRY_RUN=false
VALIDATE=false
RELOAD=false

# =============================================================================
# Functions
# =============================================================================

print_usage() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --env-file FILE    Load environment variables from file (default: .env)"
    echo "  --output FILE      Output file path (default: /etc/nginx/sites-available/default)"
    echo "  --dry-run          Print generated config to stdout without writing"
    echo "  --validate         Validate the generated configuration with nginx -t"
    echo "  --reload           Reload nginx after generating config"
    echo "  --help             Show this help message"
    echo ""
    echo "Required environment variables:"
    echo "  DOMAIN             Server domain name"
    echo "  BACKEND_PORT       Node.js backend port"
    echo "  GRAFANA_PORT       Grafana dashboard port"
    echo "  SSL_CERT_PATH      Path to SSL certificate"
    echo "  SSL_KEY_PATH       Path to SSL private key"
    echo ""
    echo "Optional environment variables:"
    echo "  MAX_BODY_SIZE      Max upload size (default: 200000M)"
    echo "  WORKER_CONNECTIONS Worker connections (default: 768)"
}

log_info() {
    echo "[INFO] $1"
}

log_error() {
    echo "[ERROR] $1" >&2
}

log_success() {
    echo "[SUCCESS] $1"
}

check_required_vars() {
    local missing=()

    [[ -z "${DOMAIN:-}" ]] && missing+=("DOMAIN")
    [[ -z "${BACKEND_PORT:-}" ]] && missing+=("BACKEND_PORT")
    [[ -z "${GRAFANA_PORT:-}" ]] && missing+=("GRAFANA_PORT")
    [[ -z "${SSL_CERT_PATH:-}" ]] && missing+=("SSL_CERT_PATH")
    [[ -z "${SSL_KEY_PATH:-}" ]] && missing+=("SSL_KEY_PATH")

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required environment variables: ${missing[*]}"
        echo ""
        echo "Please set these variables in your .env file or export them:"
        for var in "${missing[@]}"; do
            echo "  export $var=<value>"
        done
        exit 1
    fi
}

substitute_vars() {
    local template="$1"

    # Set defaults for optional variables
    export MAX_BODY_SIZE="${MAX_BODY_SIZE:-200000M}"
    export WORKER_CONNECTIONS="${WORKER_CONNECTIONS:-768}"

    # Substitute all environment variables
    # Using envsubst for reliable variable substitution
    envsubst '${DOMAIN} ${BACKEND_PORT} ${GRAFANA_PORT} ${SSL_CERT_PATH} ${SSL_KEY_PATH} ${MAX_BODY_SIZE} ${WORKER_CONNECTIONS}' < "$template"
}

# =============================================================================
# Parse Arguments
# =============================================================================

while [[ $# -gt 0 ]]; do
    case $1 in
        --env-file)
            ENV_FILE="$2"
            shift 2
            ;;
        --output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --validate)
            VALIDATE=true
            shift
            ;;
        --reload)
            RELOAD=true
            shift
            ;;
        --help)
            print_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            print_usage
            exit 1
            ;;
    esac
done

# =============================================================================
# Main Script
# =============================================================================

# Check template exists
if [[ ! -f "$TEMPLATE_FILE" ]]; then
    log_error "Template file not found: $TEMPLATE_FILE"
    exit 1
fi

# Load environment file if it exists
if [[ -f "$ENV_FILE" ]]; then
    log_info "Loading environment from: $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
else
    log_info "No .env file found at $ENV_FILE, using existing environment variables"
fi

# Check required variables
check_required_vars

# Log configuration
log_info "Configuration:"
log_info "  Domain: ${DOMAIN}"
log_info "  Backend Port: ${BACKEND_PORT}"
log_info "  Grafana Port: ${GRAFANA_PORT}"
log_info "  SSL Cert: ${SSL_CERT_PATH}"
log_info "  SSL Key: ${SSL_KEY_PATH}"
log_info "  Max Body Size: ${MAX_BODY_SIZE:-200000M}"

# Generate configuration
GENERATED_CONFIG=$(substitute_vars "$TEMPLATE_FILE")

if [[ "$DRY_RUN" == true ]]; then
    echo ""
    echo "=============================================="
    echo "Generated nginx configuration (dry run):"
    echo "=============================================="
    echo "$GENERATED_CONFIG"
    exit 0
fi

# Write configuration
log_info "Writing configuration to: $OUTPUT_FILE"

# Check if we need sudo
if [[ ! -w "$(dirname "$OUTPUT_FILE")" ]]; then
    log_info "Root permissions required, using sudo..."
    echo "$GENERATED_CONFIG" | sudo tee "$OUTPUT_FILE" > /dev/null
else
    echo "$GENERATED_CONFIG" > "$OUTPUT_FILE"
fi

log_success "Configuration written to $OUTPUT_FILE"

# Validate if requested
if [[ "$VALIDATE" == true ]]; then
    log_info "Validating nginx configuration..."
    if sudo nginx -t; then
        log_success "Configuration is valid"
    else
        log_error "Configuration validation failed"
        exit 1
    fi
fi

# Reload if requested
if [[ "$RELOAD" == true ]]; then
    log_info "Reloading nginx..."
    if sudo systemctl reload nginx; then
        log_success "Nginx reloaded successfully"
    else
        log_error "Failed to reload nginx"
        exit 1
    fi
fi

log_success "Done!"
