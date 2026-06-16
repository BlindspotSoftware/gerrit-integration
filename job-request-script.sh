#!/bin/bash
set -e

declare -A BINARIES_MAP
if [ -n "$BINARIES" ]; then
    IFS=';' read -ra PAIRS <<< "$BINARIES"
    for pair in "${PAIRS[@]}"; do
        [[ -z "$pair" ]] && continue
        key="${pair%%=*}"
        value="${pair#*=}"
        BINARIES_MAP["$key"]="$value"
    done
fi


# Check required environment variables
if [ -z "$FWCI_WORKFLOW_NAME" ] && [ -z "$FWCI_WORKFLOW_ID" ]; then
    echo "ERROR: Missing workflow reference. Set one of:"
    echo "  FWCI_WORKFLOW_NAME (preferred): workflow name as shown in FirmwareCI"
    echo "  FWCI_WORKFLOW_ID (deprecated): workflow ULID"
    exit 1
fi
if [ -n "$FWCI_WORKFLOW_NAME" ] && [ -n "$FWCI_WORKFLOW_ID" ]; then
    echo "ERROR: FWCI_WORKFLOW_NAME and FWCI_WORKFLOW_ID are mutually exclusive"
    exit 1
fi
if [ -z "$GERRIT_PATCHSET_REVISION" ]; then
    echo "ERROR: Missing required environment variable: GERRIT_PATCHSET_REVISION"
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
if ! command -v jq >/dev/null; then
    JQ_DIR="${WORKSPACE:-$HOME/.local/bin}"
    mkdir -p "$JQ_DIR"
    curl -sL -o "$JQ_DIR/jq" https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64
    chmod +x "$JQ_DIR/jq"
    export PATH="$JQ_DIR:$PATH"
fi


# Configuration
FWCI_API="${FWCI_API:-https://api.firmwareci.9esec.dev:8443}"

# FWCI_BRANCH feeds a URL query and a JSON body below; restrict to git-safe
# chars to prevent query/JSON injection.
if [ -n "$FWCI_BRANCH" ] && ! [[ "$FWCI_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "ERROR: FWCI_BRANCH contains invalid characters" >&2
    exit 1
fi

# Determine workflow reference, JSON key, and VCS query params (for name-based resolution)
if [ -n "$FWCI_WORKFLOW_NAME" ]; then
    WORKFLOW_REF="$FWCI_WORKFLOW_NAME"
    WORKFLOW_JSON_KEY="workflow_name"
    VCS_PARAMS=""
    if [ -n "$FWCI_PROJECT_LINK" ]; then
        # Strip scheme if present, then split into host/org/repo
        LINK="${FWCI_PROJECT_LINK#*://}"
        IFS='/' read -ra PARTS <<< "$LINK"
        HOST="${PARTS[0]}"
        ORG="${PARTS[1]}"
        REPO="${PARTS[2]}"
        if [[ "$HOST" == *"github"* ]]; then
            PROVIDER="github"
        elif [[ "$HOST" == *"gitlab"* ]]; then
            PROVIDER="gitlab"
        fi
        if [ -n "$PROVIDER" ] && [ -n "$ORG" ] && [ -n "$REPO" ]; then
            VCS_PARAMS="?provider=${PROVIDER}&org=${ORG}&repo=${REPO}"
            # branch-scope the upload's workflow resolution too, not just the job
            [ -n "$FWCI_BRANCH" ] && VCS_PARAMS="${VCS_PARAMS}&branch=$(jq -rn --arg v "$FWCI_BRANCH" '$v|@uri')"
        fi
    fi
else
    WORKFLOW_REF="$FWCI_WORKFLOW_ID"
    WORKFLOW_JSON_KEY="workflow_id"
    VCS_PARAMS=""
fi

echo "=== FirmwareCI Deployment ======"
echo "API: ${FWCI_API}"
[ -n "$FWCI_WORKFLOW_NAME" ] && echo "Workflow name: ${FWCI_WORKFLOW_NAME}"
[ -n "$FWCI_WORKFLOW_ID" ]   && echo "Workflow ID: ${FWCI_WORKFLOW_ID} (deprecated)"
[ -n "$FWCI_PROJECT_LINK" ]  && echo "Project link: ${FWCI_PROJECT_LINK}"
echo "Commit hash: ${GERRIT_PATCHSET_REVISION}"
[ -n "$FWCI_BRANCH" ] && echo "Workflow branch: ${FWCI_BRANCH}"
[ -n "$BINARIES" ] && echo "Templates-Keys -> Files: ${BINARIES}"
echo "================================"


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

# Step 2: Upload binaries to server (optional)
if [ -n "$BINARIES" ]; then
    echo "Step 2: Uploading binaries..."

    CURL_FORM_ARGS=()

    for key in "${!BINARIES_MAP[@]}"; do
        file="${BINARIES_MAP[$key]}"
        if [ -f "$file" ]; then
            CURL_FORM_ARGS+=("-F" "${key}=@${file}")
        else
            REMOTE_BINARIES_MAP["$key"]="$file"
        fi
    done

    UPLOAD_RESPONSE=$(curl -s -X POST "${FWCI_API}/v0/binaries/${WORKFLOW_REF}${VCS_PARAMS}" \
        -H "Authorization: ${ACCESS_TOKEN}" \
        -H "Content-Type: multipart/form-data" \
        "${CURL_FORM_ARGS[@]}")

    STATUS_CODE=$(echo "${UPLOAD_RESPONSE}" | jq -r '.code // empty')

    DATA=$(echo "${UPLOAD_RESPONSE}" | jq -c '.data // empty')

    if [ -z "$DATA" ] || [ "$STATUS_CODE" != "201" ]; then
        ERROR_MSG=$(echo "${UPLOAD_RESPONSE}" | jq -r '.error // empty')
        echo "ERROR: Failed to upload binaries"
        [ -n "$ERROR_MSG" ] && echo "Error message: $ERROR_MSG"
        exit 1
    fi

    BINARIES_JSON="$DATA"

    if [ "${#REMOTE_BINARIES_MAP[@]}" -gt 0 ]; then
        REMOTE_JSON=$(printf '{%s}' "$(IFS=,; for key in "${!REMOTE_BINARIES_MAP[@]}"; do printf '"%s":"%s"' "$key" "${REMOTE_BINARIES_MAP[$key]}"; done)")
        BINARIES_JSON=$(jq -c --argjson local "$BINARIES_JSON" --argjson remote "$REMOTE_JSON" '$local + $remote')
    fi

else
    BINARIES_JSON="{}"
fi

# Step 3: Create job with
echo "Step 3: Creating job..."

# Create JSON for gerrit data
GERRIT_JSON='"commit_hash": "'"${GERRIT_PATCHSET_REVISION}"'"'
[ -n "$GERRIT_HOST" ] && GERRIT_JSON="${GERRIT_JSON}, \"host\": \"${GERRIT_HOST}\""
[ -n "$GERRIT_CHANGE_ID" ] && GERRIT_JSON="${GERRIT_JSON}, \"change_id\": \"${GERRIT_CHANGE_ID}\""
[ -n "$GERRIT_PROJECT" ] && GERRIT_JSON="${GERRIT_JSON}, \"project\": \"${GERRIT_PROJECT}\""
[ -n "$GERRIT_CHANGE_NUMBER" ] && GERRIT_JSON="${GERRIT_JSON}, \"change_number\": \"${GERRIT_CHANGE_NUMBER}\""
[ -n "$GERRIT_PATCHSET_REVISION" ] && GERRIT_JSON="${GERRIT_JSON}, \"current_revision\": \"${GERRIT_PATCHSET_REVISION}\""
[ -n "$GERRIT_PATCHSET_NUMBER" ] && GERRIT_JSON="${GERRIT_JSON}, \"patchset\": \"${GERRIT_PATCHSET_NUMBER}\""

# Build workflow_vcs JSON for name-based resolution (required when using workflow_name)
WORKFLOW_VCS_JSON=""
if [ -n "$PROVIDER" ] && [ -n "$ORG" ] && [ -n "$REPO" ]; then
    WORKFLOW_VCS_JSON=', "workflow_vcs": {"provider": "'"${PROVIDER}"'", "org": "'"${ORG}"'", "repo": "'"${REPO}"'", "instance": "'"${HOST}"'"}'
fi

# Scope the workflow lookup to a specific branch. FirmwareCI workflows are
# branch-scoped, so branch_name selects which branch's workflow to run. Set
# FWCI_BRANCH to the firmwareci branch the workflow lives on (which may differ
# from the Gerrit change's branch). Only meaningful with workflow_name (ignored
# when resolving by workflow_id). Omitted when FWCI_BRANCH is unset, in which
# case the server uses the project's default branch.
BRANCH_NAME_JSON=""
if [ -n "$FWCI_BRANCH" ]; then
    BRANCH_NAME_JSON='"branch_name": "'"${FWCI_BRANCH}"'",'
fi

JOB_RESPONSE=$(curl -s -X POST "${FWCI_API}/v0/job" \
-H "Authorization: ${ACCESS_TOKEN}" \
-H "Content-Type: application/json" \
-d '{
    '"${BRANCH_NAME_JSON}"'
    "'"${WORKFLOW_JSON_KEY}"'": "'"${WORKFLOW_REF}"'",
    "binaries": '"${BINARIES_JSON}"',
    "info": {
        "gerrit": {
            '"${GERRIT_JSON}"'
        },
        "meta": {
          "Trigger": "Gerrit",
          "SHA": "'"${GERRIT_PATCHSET_REVISION}"'",
          "Branch": "'"${GERRIT_BRANCH}"'"
        }
        '"${WORKFLOW_VCS_JSON}"'
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
