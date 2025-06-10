# FirmwareCI Gerrit Integration

This repository provides CI/CD pipeline integration with Gerrit for automated firmware testing.

## Components

### Deployment Script (`job-request-script.sh`)

Automates firmware binary job-request to FirmwareCI, handling authentication, upload, and job creation with Gerrit metadata.

### Checks Plugin (`checks-plugin.js`)

Displays FirmwareCI job results directly in Gerrit's Checks tab with real-time status updates.

## Quick Start

1. **Set required environment variables:**

   ```bash
   export FWCI_TOKEN="your-token"
   export FWCI_WORKFLOW_ID="your-workflow-id"
   export FILE="path/to/firmware.bin"
   export COMMIT_HASH="$(git rev-parse HEAD)"
   ```

2. **Run job-request:**
   ```bash
   ./job-request-script.sh
   ```

## Environment Variables

### Required

| Variable           | Description                     |
| ------------------ | ------------------------------- |
| `FWCI_TOKEN`       | FirmwareCI authentication token |
| `FWCI_WORKFLOW_ID` | Workflow ID to execute          |
| `FILE`             | Path to firmware binary         |
| `COMMIT_HASH`      | Git commit hash                 |

### Gerrit Integration (Optional)

| Variable           | Description                |
| ------------------ | -------------------------- |
| `CHANGE_ID`        | Gerrit change ID           |
| `PROJECT`          | Gerrit project name        |
| `CHANGE_NUMBER`    | Gerrit change number       |
| `CURRENT_REVISION` | Current revision           |
| `PATCHSET`         | Patchset number            |
| `REVIEW`           | Enable review comments     |
| `VOTE`             | Enable voting via comments |

### Alternative Authentication

| Variable        | Description                                              |
| --------------- | -------------------------------------------------------- |
| `FWCI_EMAIL`    | Account email (instead of token)                         |
| `FWCI_PASSWORD` | Account password (instead of token)                      |
| `FWCI_API`      | API URL (default: https://api.firmwareci.9esec.dev:8443) |

## Configuration

Modify the `CONFIG` object in `checks-plugin.js`:

```javascript
const CONFIG = Object.freeze({
  PLUGIN_VERSION: "1.0.0",
  API_VERSION: "3.12.0",
  FIRMWARE_CI_API_URL: "https://api.firmwareci.9esec.dev:8443/v0",
  FIRMWARE_CI_URL: "https://app.firmware-ci.com/app",
  POLLING_INTERVAL_SECONDS: 60,
});
```

## Jenkins Integration

```groovy
stage('FirmwareCI Testing') {
  environment {
     FWCI_TOKEN = credentials('fwci-token')
     FWCI_WORKFLOW_ID = 'your-workflow-id'
     FILE = 'build/firmware.bin'
     COMMIT_HASH = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
     CHANGE_ID = env.GERRIT_CHANGE_ID
     PROJECT = env.GERRIT_PROJECT
     CHANGE_NUMBER = env.GERRIT_CHANGE_NUMBER
     PATCHSET = env.GERRIT_PATCHSET_NUMBER
  }
  steps {
     sh './job-request-script.sh'
  }
}
```

## Plugin Installation

### Prerequisites

- Gerrit 3.12+
- Gerrit repository linked with FirmwareCI ([Integration Guide](https://docs.firmware-ci.com/usage/1_initial_setup/index.html#integration-sources))
- Deployment script configured with Gerrit metadata

### Install

```bash
cp checks-plugin.js /path/to/gerrit/plugins/firmware-ci-checks.js
```

## Troubleshooting

### Common Issues

- **Authentication fails**: Verify `FWCI_TOKEN` is valid
- **File not found**: Check `FILE` path exists and is accessible
- **Plugin not loading**: Ensure Gerrit version compatibility (3.12+)
- **No results in Checks tab**: Verify Gerrit metadata variables are set in the script

### Support

- [FirmwareCI Documentation](https://docs.firmware-ci.com/)
- [Gerrit Checks API](https://gerrit-review.googlesource.com/Documentation/pg-plugin-checks-api.html)
