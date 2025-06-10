#!/bin/bash
set -e

# Check required environment variables
if [ -z "$FWCI_WORKFLOW_ID" ] || [ -z "$FILE" ] || [ -z "$COMMIT_HASH" ]; then
    echo "ERROR: Missing required environment variables:"
    echo "  FWCI_WORKFLOW_ID: ${FWCI_WORKFLOW_ID:-'(not set)'}"
    echo "  FILE: ${FILE:-'(not set)'}"
    echo "  COMMIT_HASH: ${COMMIT_HASH:-'(not set)'}"
    exit 1
fi

# Check authentication variables
if [ -n "$FWCI_TOKEN" ]; then
    AUTH_METHOD="token"
    ACCESS_TOKEN="$FWCI_TOKEN"
elif [ -n "$FWCI_EMAIL" ] && [ -n "$FWCI_PASSWORD" ]; then
    AUTH_METHOD="email_password"
else
    echo "ERROR: Authentication required. Provide either:"
    echo "  FWCI_TOKEN for token authentication, or"
    echo "  FWCI_EMAIL and FWCI_PASSWORD for email/password authentication"
    exit 1
fi

# Install dependencies
apt-get update && apt-get install -y curl jq

# Configuration
FWCI_API="${FWCI_API:-https://api.firmwareci.9esec.dev:8443}"
echo "=== FirmwareCI Deployment ======"
echo "API: ${FWCI_API}"
echo "Workflow ID: ${FWCI_WORKFLOW_ID}"
echo "Commit hash: ${COMMIT_HASH}"
echo "File to upload: ${FILE}"
echo "Auth method: ${AUTH_METHOD}"
echo "================================"

# Check if ROM file exists
if [ ! -f "$FILE" ]; then
    echo "ERROR: file not found: $FILE"
    exit 1
fi

# Step 1: Authenticate (only if using email/password)
if [ "$AUTH_METHOD" = "email_password" ]; then
    echo "Step 1: Authenticating with FirmwareCI..."
    LOGIN_RESPONSE=$(curl -s -X POST "${FWCI_API}/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"${FWCI_EMAIL}\", \"password\": \"${FWCI_PASSWORD}\"}")
    
    echo "Login response: ${LOGIN_RESPONSE}"
    STATUS_CODE=$(echo "${LOGIN_RESPONSE}" | jq -r '.code // empty')
    ACCESS_TOKEN=$(echo "${LOGIN_RESPONSE}" | jq -r '.data // empty')
    
    if [ -z "$ACCESS_TOKEN" ] || [ "$STATUS_CODE" != "200" ]; then
        echo "ERROR: Failed to get access token"
        echo "Status code: ${STATUS_CODE}"
        echo "Response: ${LOGIN_RESPONSE}"
        exit 1
    fi
    echo "Authentication successful"
else
    echo "Step 1: Using provided token for authentication"
fi

# Step 2: Upload binary to server
echo "Step 2: Uploading binary..."
UPLOAD_RESPONSE=$(curl -s -X POST "${FWCI_API}/v0/binary/${FWCI_WORKFLOW_ID}" \
-H "Authorization: ${ACCESS_TOKEN}" \
-H "Content-Type: multipart/form-data" \
-F "file=@${FILE}")

echo "Upload response: ${UPLOAD_RESPONSE}"
STATUS_CODE=$(echo "${UPLOAD_RESPONSE}" | jq -r '.code // empty')
BINARY_URI=$(echo "${UPLOAD_RESPONSE}" | jq -r '.data // empty')

if [ -z "$BINARY_URI" ] || [ "$STATUS_CODE" != "201" ]; then
    echo "ERROR: Failed to upload binary or get URI"
    echo "Status code: ${STATUS_CODE}"
    echo "Response: ${UPLOAD_RESPONSE}"
    exit 1
fi

echo "Binary uploaded successfully, URI: ${BINARY_URI}"

# Step 3: Create job with the binary URI
echo "Step 3: Creating job..."

# Create JSON for gerrit data
GERRIT_JSON='"commit_hash": "'"${COMMIT_HASH}"'"'
[ -n "$CHANGE_ID" ] && GERRIT_JSON="${GERRIT_JSON}, \"change_id\": \"${CHANGE_ID}\""
[ -n "$PROJECT" ] && GERRIT_JSON="${GERRIT_JSON}, \"project\": \"${PROJECT}\""
[ -n "$COMMENT" ] && GERRIT_JSON="${GERRIT_JSON}, \"comment\": true"
[ -n "$CHANGE_NUMBER" ] && GERRIT_JSON="${GERRIT_JSON}, \"change_number\": \"${CHANGE_NUMBER}\""
[ -n "$CURRENT_REVISION" ] && GERRIT_JSON="${GERRIT_JSON}, \"current_revision\": \"${CURRENT_REVISION}\""
[ -n "$PATCHSET" ] && GERRIT_JSON="${GERRIT_JSON}, \"patchset\": \"${PATCHSET}\""

JOB_RESPONSE=$(curl -s -X POST "${FWCI_API}/v0/job" \
-H "Authorization: ${ACCESS_TOKEN}" \
-H "Content-Type: application/json" \
-d '{
    "workflow_id": "'"${FWCI_WORKFLOW_ID}"'",
    "binary": "'"${BINARY_URI}"'",
    "info": {
        "gerrit": {
            '"${GERRIT_JSON}"'
        },
        "meta": {
          "Trigger": "Gerrit",
          "File": "'"$(basename "${FILE}")"'",
          "SHA": "'"${COMMIT_HASH}"'"
        }
    }
}')

echo "Job response: ${JOB_RESPONSE}"
STATUS_CODE=$(echo "${JOB_RESPONSE}" | jq -r '.code // empty')

if [ "$STATUS_CODE" != "201" ]; then
    echo "ERROR: Failed to create job"
    echo "Status code: ${STATUS_CODE}"
    echo "Response: ${JOB_RESPONSE}"
    exit 1
fi

echo "Job created successfully!"
echo "Deployment completed!"