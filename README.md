# FirmwareCI Gerrit Integration

This repository provides CI/CD pipeline integration with Gerrit for automated firmware testing.

## Prerequisites

- Gerrit repository linked with FirmwareCI ([Integration Guide](https://docs.firmware-ci.com/usage/1_initial_setup/index.html))


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
   export BINARIES="Binary=path/to/firmware.bin"
   export COMMIT_HASH="$(git rev-parse HEAD)"
   ```

2. **Run job-request:**

   ```bash
   ./job-request-script.sh
   ```

## Environment Variables

### Required

| Variable           | Description                                   |
| ------------------ | --------------------------------------------- |
| `FWCI_TOKEN`       | FirmwareCI authentication token               |
| `FWCI_WORKFLOW_ID` | Workflow ID to execute                        |
| `BINARIES`         | Key-value pairs of template names to binary paths |
| `COMMIT_HASH`      | Git commit hash                               |

### Gerrit Integration (Optional)

| Variable           | Description                |
| ------------------ | -------------------------- |
| `CHANGE_ID`        | Gerrit change ID           |
| `PROJECT`          | Gerrit project name        |
| `CHANGE_NUMBER`    | Gerrit change number       |
| `CURRENT_REVISION` | Current revision           |
| `PATCHSET`         | Patchset number            |
| `COMMENT`          | Enable review comments     |
| `VOTE`             | Enable voting via comments |

### Alternative Authentication

| Variable        | Description                                              |
| --------------- | -------------------------------------------------------- |
| `FWCI_EMAIL`    | Account email (instead of token)                         |
| `FWCI_PASSWORD` | Account password (instead of token)                      |
| `FWCI_API`      | API URL (default: <https://api.firmwareci.9esec.dev:8443>) |

### Configuration

Modify the `CONFIG` object in `checks-plugin.js`:

```javascript
const CONFIG = Object.freeze({
  PLUGIN_VERSION: "1.0.0",
  API_VERSION: "3.12.0",
  FIRMWARE_CI_API_URL: "https://api..com/app",
  POLLING_INTERVAL_SECONDS: 60,
});
```

## Comments & Labels Configuration

To enable automated commenting and label voting functionality, a dedicated service account must be configured with appropriate permissions.

### Service Account Setup

Create a dedicated service account for FirmwareCI integration:

```bash
ssh -p 29418 <GERRIT_INSTANCE> gerrit create-account --http-password <PASSWORD> firmwareci
```

### Required Permissions

Configure the following permissions for the `firmwareci` service account:

- **Read Access**: Grant `Read` permission to `refs/*`
- **Label Verification**: Grant `Label Verified` permission to `refs/heads/*`

Add the service account to your instance's service users group to ensure proper access control.

### Important Notes

- When `COMMENT` and/or `VOTE` environment variables are configured, the service account will handle these operations automatically

## Jenkins Integration

```groovy
stage('FirmwareCI Testing') {
  environment {
     FWCI_TOKEN = credentials('fwci-token')
     FWCI_WORKFLOW_ID = 'your-workflow-id'
     BINARIES = 'Binary=build/firmware.bin'
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
- **File not found**: Check `BiNARIES` paths exist and are accessible
- **No results in Checks tab**: Verify Gerrit metadata variables are set in the script

### Support

- [FirmwareCI Documentation](https://docs.firmware-ci.com/)
- [Gerrit Checks API](https://gerrit-review.googlesource.com/Documentation/pg-plugin-checks-api.html)
